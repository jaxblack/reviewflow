import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z, ZodError } from 'zod'
import {
  CapacityGuard,
  CapacityLimitError,
  resolveCapacityLimits,
  type CapacityLimits,
} from './capacity.js'
import { createDatabase, USER_IDS, withImmediateTransaction } from './db.js'
import type {
  ContentStatus,
  ContentRow,
  CurrentUser,
  DecisionRow,
  DecisionType,
  Risk,
  Role,
  RoundContextRow,
  RoundStatus,
} from './types.js'

const contentInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(50_000),
    risk: z.enum(['LOW', 'HIGH']),
  })
  .strict()

const editContentSchema = contentInputSchema
  .extend({ expectedVersion: z.number().int().positive() })
  .strict()

const submitContentSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict()

const decisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    comment: z.string().max(2_000).optional(),
  })
  .strict()

const switchUserSchema = z.object({ userId: z.string().min(1) }).strict()
const idParamsSchema = z.object({ id: z.string().min(1) }).strict()
const contentListQuerySchema = z
  .object({ scope: z.enum(['mine', 'all']).default('mine') })
  .strict()
const rolesSchema = z
  .array(z.enum(['SUBMITTER', 'REVIEWER', 'ADMIN']))
  .min(1)
  .max(3)
  .refine((roles) => new Set(roles).size === roles.length, {
    message: '角色不能重复',
  })
const adminUserInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    roles: rolesSchema,
  })
  .strict()

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface BuildAppOptions {
  database?: DatabaseSync
  databasePath?: string
  logger?: boolean
  serveStatic?: boolean
  sessionSecret?: string
  capacityLimits?: Partial<CapacityLimits>
  writeRateLimitMax?: number
  beforeWriteRequest?: (request: FastifyRequest) => void | Promise<void>
}

interface IdempotentResult<T> {
  statusCode: number
  body: T
  replayed: boolean
}

interface SummaryRow {
  id: string
  author_id: string
  title: string
  risk: Risk
  status: ContentStatus
  version: number
  created_at: string
  updated_at: string
  author_name: string
  current_round_id: string | null
  current_round_no: number | null
  round_status: string | null
  required_approvals: number | null
  approval_count: number
  round_count: number
}

type WorkspaceQueue = 'MINE' | 'PENDING_REVIEW' | 'REVIEWED' | 'ADMIN'

interface ContentSummaryDto {
  id: string
  title: string
  risk: Risk
  status: ContentStatus
  version: number
  author: { id: string; name: string }
  createdAt: string
  updatedAt: string
  roundCount: number
  currentRound: {
    id: string
    roundNo: number
    status: RoundStatus
    approvalCount: number
    requiredApprovals: number
  } | null
}

interface WorkspaceItemDto extends ContentSummaryDto {
  queues: WorkspaceQueue[]
}

interface AdminUserDto extends CurrentUser {
  createdAt: string
  contentCount: number
  decisionCount: number
}

interface HistoryRoundRow {
  id: string
  round_no: number
  required_approvals: number
  status: string
  started_at: string
  completed_at: string | null
  revision_id: string
  title: string
  body: string
  risk: string
  author_name_snapshot: string
  submitted_at: string
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const ownsDatabase = options.database === undefined
  const capacityLimits = resolveCapacityLimits(options.capacityLimits)
  const database = options.database ?? createDatabase(options.databasePath, capacityLimits)
  const capacityGuard = new CapacityGuard(database, capacityLimits)
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: ['127.0.0.1', '::1'],
  })
  const writeRateLimitMax = resolvePositiveInteger(
    options.writeRateLimitMax,
    process.env.REVIEWFLOW_WRITE_RATE_LIMIT,
    30,
    'REVIEWFLOW_WRITE_RATE_LIMIT',
  )
  const configuredSessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET
  if (!configuredSessionSecret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production')
  }
  const sessionSecret =
    configuredSessionSecret ?? 'reviewflow-local-session-secret-change-me'

  await app.register(cookie, { secret: sessionSecret, hook: 'onRequest' })
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: {
        code: 'RATE_LIMITED',
        message: `写入请求过于频繁，请在 ${context.after} 后重试`,
      },
    }),
  })
  const writeRouteOptions = {
    onRequest: app.rateLimit({
      max: writeRateLimitMax,
      timeWindow: 60_000,
    }),
    ...(options.beforeWriteRequest
      ? { preHandler: options.beforeWriteRequest }
      : {}),
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      })
    }
    if (error instanceof CapacityLimitError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      })
    }
    const rateLimitError = error as unknown as {
      statusCode?: number
      error?: { code?: string; message?: string }
    }
    if (
      rateLimitError.statusCode === 429 &&
      rateLimitError.error?.code === 'RATE_LIMITED'
    ) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: rateLimitError.error.message ?? '写入请求过于频繁，请稍后重试',
        },
      })
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: error.issues[0]?.message ?? '请求参数不合法',
        },
      })
    }
    app.log.error(error)
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' },
    })
  })

  app.addHook('onClose', () => {
    if (ownsDatabase) database.close()
  })

  app.get('/api/health', () => ({ status: 'ok', database: 'sqlite' }))

  app.get('/api/users', () => listUsers(database))

  app.get('/api/me', (request) => getCurrentUser(database, request))

  app.get('/api/admin/users', (request) => {
    const user = getCurrentUser(database, request)
    requireRole(user, 'ADMIN')
    return listAdminUsers(database)
  })

  app.post('/api/admin/users', writeRouteOptions, (request, reply) => {
    const user = getCurrentUser(database, request)
    requireRole(user, 'ADMIN')
    const parsed = adminUserInputSchema.parse(request.body)
    const input = { ...parsed, roles: [...parsed.roles].sort() as Role[] }
    const key = getIdempotencyKey(request)

    const result = executeIdempotent(
      database,
      user.id,
      'CREATE_USER',
      key,
      input,
      capacityGuard,
      () => {
        capacityGuard.assertUserCapacity()
        ensureUserNameAvailable(database, input.name)
        const id = randomUUID()
        database
          .prepare(`
            INSERT INTO users (id, display_name, created_at)
            VALUES (?, ?, ?)
          `)
          .run(id, input.name, new Date().toISOString())
        replaceUserRoles(database, id, input.roles)
        return { statusCode: 201, body: getAdminUser(database, id) }
      },
    )
    return sendIdempotent(reply, result)
  })

  app.patch('/api/admin/users/:id', writeRouteOptions, (request, reply) => {
    const user = getCurrentUser(database, request)
    requireRole(user, 'ADMIN')
    const { id } = idParamsSchema.parse(request.params)
    const parsed = adminUserInputSchema.parse(request.body)
    const input = { ...parsed, roles: [...parsed.roles].sort() as Role[] }
    const key = getIdempotencyKey(request)

    const result = executeIdempotent(
      database,
      user.id,
      `UPDATE_USER:${id}`,
      key,
      input,
      capacityGuard,
      () => {
        const target = getUser(database, id)
        if (!target) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在')
        ensureUserNameAvailable(database, input.name, id)
        ensureRoleChangeAllowed(database, target, input.roles)
        database
          .prepare('UPDATE users SET display_name = ? WHERE id = ?')
          .run(input.name, id)
        replaceUserRoles(database, id, input.roles)
        return { statusCode: 200, body: getAdminUser(database, id) }
      },
    )
    return sendIdempotent(reply, result)
  })

  app.get('/api/workspace', (request) => {
    const user = getCurrentUser(database, request)
    return buildWorkspace(database, user)
  })

  app.post('/api/session/switch', writeRouteOptions, (request, reply) => {
    const input = switchUserSchema.parse(request.body)
    const user = getUser(database, input.userId)
    if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在')

    reply.setCookie('reviewflow_user', user.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      path: process.env.COOKIE_PATH ?? '/',
      signed: true,
    })
    return user
  })

  app.get('/api/contents', (request) => {
    const user = getCurrentUser(database, request)
    const query = contentListQuerySchema.parse(request.query)
    if (query.scope === 'all') {
      requireRole(user, 'ADMIN')
      return listContentSummaries(database)
    }
    requireRole(user, 'SUBMITTER')
    return listContentSummaries(database, 'WHERE c.author_id = ?', [user.id])
  })

  app.post('/api/contents', writeRouteOptions, (request, reply) => {
    const user = getCurrentUser(database, request)
    requireRole(user, 'SUBMITTER')
    const input = contentInputSchema.parse(request.body)
    const key = getIdempotencyKey(request)

    const result = executeIdempotent(
      database,
      user.id,
      'CREATE_CONTENT',
      key,
      input,
      capacityGuard,
      () => {
        capacityGuard.assertContentCapacity()
        const id = randomUUID()
        const now = new Date().toISOString()
        database
          .prepare(`
            INSERT INTO contents (
              id, author_id, title, body, risk, status, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'DRAFT', 1, ?, ?)
          `)
          .run(id, user.id, input.title, input.body, input.risk, now, now)
        return { statusCode: 201, body: getContentDetail(database, user, id) }
      },
    )
    return sendIdempotent(reply, result)
  })

  app.get('/api/contents/:id', (request) => {
    const user = getCurrentUser(database, request)
    const { id } = idParamsSchema.parse(request.params)
    return getContentDetail(database, user, id)
  })

  app.get('/api/contents/:id/history', (request) => {
    const user = getCurrentUser(database, request)
    const { id } = idParamsSchema.parse(request.params)
    return getContentDetail(database, user, id).history
  })

  app.patch('/api/contents/:id', writeRouteOptions, (request, reply) => {
    const user = getCurrentUser(database, request)
    requireRole(user, 'SUBMITTER')
    const { id } = idParamsSchema.parse(request.params)
    const input = editContentSchema.parse(request.body)
    const key = getIdempotencyKey(request)

    const result = executeIdempotent(
      database,
      user.id,
      `EDIT_CONTENT:${id}`,
      key,
      input,
      capacityGuard,
      () => {
        const content = requireContent(database, id)
        requireAuthor(user, content)
        if (content.status !== 'DRAFT' && content.status !== 'REJECTED') {
          throw new ApiError(409, 'INVALID_STATE', '当前状态不允许编辑')
        }
        if (content.version !== input.expectedVersion) {
          throw new ApiError(409, 'STALE_VERSION', '内容已更新，请刷新后重试')
        }

        database
          .prepare(`
            UPDATE contents
            SET title = ?, body = ?, risk = ?, version = version + 1, updated_at = ?
            WHERE id = ?
          `)
          .run(input.title, input.body, input.risk, new Date().toISOString(), id)
        return { statusCode: 200, body: getContentDetail(database, user, id) }
      },
    )
    return sendIdempotent(reply, result)
  })

  app.post('/api/contents/:id/submit', writeRouteOptions, (request, reply) => {
    const user = getCurrentUser(database, request)
    requireRole(user, 'SUBMITTER')
    const { id } = idParamsSchema.parse(request.params)
    const input = submitContentSchema.parse(request.body)
    const key = getIdempotencyKey(request)

    const result = executeIdempotent(
      database,
      user.id,
      `SUBMIT_CONTENT:${id}`,
      key,
      input,
      capacityGuard,
      () => {
        const content = requireContent(database, id)
        requireAuthor(user, content)
        if (content.status !== 'DRAFT' && content.status !== 'REJECTED') {
          throw new ApiError(409, 'INVALID_STATE', '当前状态不允许提交')
        }
        if (content.version !== input.expectedVersion) {
          throw new ApiError(409, 'STALE_VERSION', '内容已更新，请刷新后重试')
        }
        capacityGuard.assertRoundCapacity(id)

        const requiredApprovals = content.risk === 'LOW' ? 1 : 2
        const eligible = database
          .prepare(`
            SELECT count(DISTINCT user_id) AS count
            FROM user_roles
            WHERE role = 'REVIEWER' AND user_id <> ?
          `)
          .get(content.author_id) as unknown as { count: number }
        if (eligible.count < requiredApprovals) {
          throw new ApiError(
            422,
            'INSUFFICIENT_REVIEWERS',
            '当前没有足够的合法审核人',
          )
        }

        const numberRow = database
          .prepare(`
            SELECT coalesce(max(round_no), 0) + 1 AS next_number
            FROM review_rounds WHERE content_id = ?
          `)
          .get(id) as unknown as { next_number: number }
        const revisionId = randomUUID()
        const roundId = randomUUID()
        const now = new Date().toISOString()

        database
          .prepare(`
            INSERT INTO content_revisions (
              id, content_id, revision_no, title, body, risk,
              author_id, author_name_snapshot, submitted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            revisionId,
            id,
            numberRow.next_number,
            content.title,
            content.body,
            content.risk,
            content.author_id,
            user.name,
            now,
          )
        database
          .prepare(`
            INSERT INTO review_rounds (
              id, content_id, revision_id, round_no, required_approvals,
              status, started_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, NULL)
          `)
          .run(
            roundId,
            id,
            revisionId,
            numberRow.next_number,
            requiredApprovals,
            now,
          )
        database
          .prepare(`
            UPDATE contents
            SET status = 'IN_REVIEW', version = version + 1, updated_at = ?
            WHERE id = ?
          `)
          .run(now, id)

        return { statusCode: 201, body: getContentDetail(database, user, id) }
      },
    )
    return sendIdempotent(reply, result)
  })

  app.get('/api/reviews/pending', (request) => {
    const user = getCurrentUser(database, request)
    requireRole(user, 'REVIEWER')
    return listPendingContentSummaries(database, user.id)
  })

  app.post('/api/review-rounds/:id/decisions', writeRouteOptions, (request, reply) => {
    const user = getCurrentUser(database, request)
    requireRole(user, 'REVIEWER')
    const { id: roundId } = idParamsSchema.parse(request.params)
    const input = decisionSchema.parse(request.body)
    const normalizedComment = input.comment?.trim() || null
    if (input.decision === 'REJECT' && !normalizedComment) {
      throw new ApiError(
        422,
        'REJECTION_REASON_REQUIRED',
        '拒绝时必须填写理由',
      )
    }
    const key = getIdempotencyKey(request)

    const result = executeIdempotent(
      database,
      user.id,
      `REVIEW_DECISION:${roundId}`,
      key,
      { decision: input.decision, comment: normalizedComment },
      capacityGuard,
      () => {
        const round = getRoundContext(database, roundId)
        if (!round) throw new ApiError(404, 'ROUND_NOT_FOUND', '审核轮次不存在')
        if (round.author_id === user.id) {
          throw new ApiError(409, 'SELF_REVIEW_FORBIDDEN', '不能审核自己创建的内容')
        }

        const previous = database
          .prepare(`
            SELECT * FROM review_decisions
            WHERE round_id = ? AND reviewer_id = ?
          `)
          .get(roundId, user.id) as unknown as DecisionRow | undefined
        if (previous) {
          if (
            previous.decision === input.decision &&
            previous.comment === normalizedComment
          ) {
            return {
              statusCode: 200,
              body: getContentDetail(database, user, round.content_id),
            }
          }
          throw new ApiError(409, 'ALREADY_DECIDED', '本轮已经做出审核决定')
        }

        if (round.status !== 'OPEN' || round.content_status !== 'IN_REVIEW') {
          throw new ApiError(409, 'ROUND_CLOSED', '审核轮次已经结束')
        }

        const now = new Date().toISOString()
        database
          .prepare(`
            INSERT INTO review_decisions (
              id, round_id, reviewer_id, reviewer_name_snapshot,
              decision, comment, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            randomUUID(),
            roundId,
            user.id,
            user.name,
            input.decision,
            normalizedComment,
            now,
          )

        const finalStatus = getFinalStatus(database, round, input.decision)
        if (finalStatus) {
          const roundUpdate = database
            .prepare(`
              UPDATE review_rounds
              SET status = ?, completed_at = ?
              WHERE id = ? AND status = 'OPEN'
            `)
            .run(finalStatus, now, roundId)
          if (roundUpdate.changes !== 1) {
            throw new ApiError(409, 'ROUND_CLOSED', '审核轮次已经结束')
          }
        }

        const contentUpdate = database
          .prepare(`
            UPDATE contents
            SET status = coalesce(?, status),
                version = version + 1,
                updated_at = ?
            WHERE id = ? AND status = 'IN_REVIEW'
          `)
          .run(finalStatus, now, round.content_id)
        if (contentUpdate.changes !== 1) {
          throw new ApiError(409, 'INVALID_STATE', '内容状态已经变化')
        }

        return {
          statusCode: 200,
          body: getContentDetail(database, user, round.content_id),
        }
      },
    )
    return sendIdempotent(reply, result)
  })

  if (options.serveStatic) {
    const staticRoot = join(process.cwd(), 'dist')
    if (existsSync(staticRoot)) {
      await app.register(fastifyStatic, { root: staticRoot })
    }
  }

  return app
}

function getFinalStatus(
  database: DatabaseSync,
  round: RoundContextRow,
  decision: DecisionType,
): 'APPROVED' | 'REJECTED' | null {
  if (decision === 'REJECT') return 'REJECTED'
  const countRow = database
    .prepare(`
      SELECT count(*) AS count
      FROM review_decisions
      WHERE round_id = ? AND decision = 'APPROVE'
    `)
    .get(round.id) as unknown as { count: number }
  return countRow.count >= round.required_approvals ? 'APPROVED' : null
}

function resolvePositiveInteger(
  override: number | undefined,
  environmentValue: string | undefined,
  fallback: number,
  name: string,
): number {
  const value = override ?? (environmentValue === undefined ? fallback : Number(environmentValue))
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function executeIdempotent<T>(
  database: DatabaseSync,
  actorId: string,
  operation: string,
  key: string,
  requestBody: unknown,
  capacityGuard: CapacityGuard,
  action: () => { statusCode: number; body: T },
): IdempotentResult<T> {
  return withImmediateTransaction(database, () => {
    capacityGuard.removeExpiredIdempotencyRecords()
    const requestHash = createHash('sha256')
      .update(JSON.stringify(requestBody))
      .digest('hex')
    const previous = database
      .prepare(`
        SELECT request_hash, status_code, response_body
        FROM idempotency_requests
        WHERE actor_id = ? AND operation = ? AND idempotency_key = ?
      `)
      .get(actorId, operation, key) as unknown as
      | { request_hash: string; status_code: number; response_body: string }
      | undefined

    if (previous) {
      if (previous.request_hash !== requestHash) {
        throw new ApiError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          '幂等键已经用于不同请求',
        )
      }
      return {
        statusCode: previous.status_code,
        body: JSON.parse(previous.response_body) as T,
        replayed: true,
      }
    }

    capacityGuard.assertPersistentWriteAllowed()

    const result = action()
    database
      .prepare(`
        INSERT INTO idempotency_requests (
          actor_id, operation, idempotency_key, request_hash,
          status_code, response_body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        actorId,
        operation,
        key,
        requestHash,
        result.statusCode,
        JSON.stringify(result.body),
        new Date().toISOString(),
      )
    return { ...result, replayed: false }
  })
}

function sendIdempotent<T>(
  reply: FastifyReply,
  result: IdempotentResult<T>,
): FastifyReply {
  return reply
    .header('Idempotency-Replayed', String(result.replayed))
    .status(result.statusCode)
    .send(result.body)
}

function getIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || value.length < 8 || value.length > 100) {
    throw new ApiError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      '写请求必须提供有效的 Idempotency-Key',
    )
  }
  return value
}

function getCurrentUser(
  database: DatabaseSync,
  request: FastifyRequest,
): CurrentUser {
  const cookieValue = request.cookies.reviewflow_user
  let userId = USER_IDS.alice
  if (cookieValue) {
    const unsigned = request.unsignCookie(cookieValue)
    if (!unsigned.valid) {
      throw new ApiError(401, 'INVALID_SESSION', '用户会话无效')
    }
    userId = unsigned.value as typeof USER_IDS.alice
  }
  const user = getUser(database, userId)
  if (!user) throw new ApiError(401, 'INVALID_SESSION', '用户会话无效')
  return user
}

function listUsers(database: DatabaseSync): CurrentUser[] {
  const rows = database
    .prepare('SELECT id FROM users ORDER BY display_name')
    .all() as unknown as Array<{ id: string }>
  return rows.map(({ id }) => getUser(database, id) as CurrentUser)
}

function listAdminUsers(database: DatabaseSync): AdminUserDto[] {
  const rows = database
    .prepare('SELECT id FROM users ORDER BY display_name, id')
    .all() as unknown as Array<{ id: string }>
  return rows.map(({ id }) => getAdminUser(database, id))
}

function getAdminUser(database: DatabaseSync, userId: string): AdminUserDto {
  const user = getUser(database, userId)
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在')
  const facts = database
    .prepare(`
      SELECT u.created_at,
        (SELECT count(*) FROM contents c WHERE c.author_id = u.id) AS content_count,
        (
          SELECT count(*) FROM review_decisions rd
          WHERE rd.reviewer_id = u.id
        ) AS decision_count
      FROM users u
      WHERE u.id = ?
    `)
    .get(userId) as unknown as {
      created_at: string
      content_count: number
      decision_count: number
    }
  return {
    ...user,
    createdAt: facts.created_at,
    contentCount: facts.content_count,
    decisionCount: facts.decision_count,
  }
}

function getUser(database: DatabaseSync, userId: string): CurrentUser | null {
  const user = database
    .prepare('SELECT id, display_name FROM users WHERE id = ?')
    .get(userId) as unknown as
    | { id: string; display_name: string }
    | undefined
  if (!user) return null
  const roleRows = database
    .prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role')
    .all(userId) as unknown as Array<{ role: Role }>
  return { id: user.id, name: user.display_name, roles: roleRows.map((row) => row.role) }
}

function ensureUserNameAvailable(
  database: DatabaseSync,
  name: string,
  excludedUserId?: string,
): void {
  const existing = database
    .prepare(`
      SELECT 1 FROM users
      WHERE display_name = ? COLLATE NOCASE
        AND (? IS NULL OR id <> ?)
      LIMIT 1
    `)
    .get(name, excludedUserId ?? null, excludedUserId ?? null)
  if (existing) {
    throw new ApiError(409, 'USER_NAME_EXISTS', '用户名称已经存在')
  }
}

function ensureRoleChangeAllowed(
  database: DatabaseSync,
  target: CurrentUser,
  nextRoles: Role[],
): void {
  if (target.roles.includes('ADMIN') && !nextRoles.includes('ADMIN')) {
    const adminCount = database
      .prepare(`
        SELECT count(DISTINCT user_id) AS count
        FROM user_roles WHERE role = 'ADMIN'
      `)
      .get() as unknown as { count: number }
    if (adminCount.count <= 1) {
      throw new ApiError(
        409,
        'LAST_ADMIN_REQUIRED',
        '系统必须至少保留一位管理员',
      )
    }
  }

  if (target.roles.includes('REVIEWER') && !nextRoles.includes('REVIEWER')) {
    const blockedRound = database
      .prepare(`
        SELECT rr.id
        FROM review_rounds rr
        JOIN contents c ON c.id = rr.content_id
        WHERE rr.status = 'OPEN'
          AND c.author_id <> ?
          AND (
            SELECT count(DISTINCT ur.user_id)
            FROM user_roles ur
            WHERE ur.role = 'REVIEWER'
              AND ur.user_id <> c.author_id
              AND ur.user_id <> ?
              AND NOT EXISTS (
                SELECT 1
                FROM review_decisions decided
                WHERE decided.round_id = rr.id
                  AND decided.reviewer_id = ur.user_id
              )
          ) < (
            rr.required_approvals - (
              SELECT count(*)
              FROM review_decisions approved
              WHERE approved.round_id = rr.id
                AND approved.decision = 'APPROVE'
            )
          )
        LIMIT 1
      `)
      .get(target.id, target.id)
    if (blockedRound) {
      throw new ApiError(
        409,
        'ROLE_CHANGE_WOULD_BLOCK_OPEN_ROUND',
        '该角色仍是进行中审核所需的合法审核人',
      )
    }
  }
}

function replaceUserRoles(
  database: DatabaseSync,
  userId: string,
  roles: Role[],
): void {
  database.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
  const insert = database.prepare(`
    INSERT INTO user_roles (user_id, role) VALUES (?, ?)
  `)
  for (const role of roles) insert.run(userId, role)
}

function requireRole(user: CurrentUser, role: Role): void {
  if (!user.roles.includes(role)) {
    throw new ApiError(403, 'ROLE_REQUIRED', `需要 ${role} 角色`)
  }
}

function requireAuthor(user: CurrentUser, content: ContentRow): void {
  if (content.author_id !== user.id) {
    throw new ApiError(403, 'AUTHOR_REQUIRED', '只有内容作者可以执行此操作')
  }
}

function requireContent(database: DatabaseSync, id: string): ContentRow {
  const content = database
    .prepare('SELECT * FROM contents WHERE id = ?')
    .get(id) as unknown as ContentRow | undefined
  if (!content) throw new ApiError(404, 'CONTENT_NOT_FOUND', '内容不存在')
  return content
}

function getRoundContext(
  database: DatabaseSync,
  roundId: string,
): RoundContextRow | null {
  return (
    (database
      .prepare(`
        SELECT rr.*, c.author_id, c.status AS content_status
        FROM review_rounds rr
        JOIN contents c ON c.id = rr.content_id
        WHERE rr.id = ?
      `)
      .get(roundId) as unknown as RoundContextRow | undefined) ?? null
  )
}

function listContentSummaries(
  database: DatabaseSync,
  where = '',
  params: string[] = [],
  snapshotViewerId?: string,
): ContentSummaryDto[] {
  const protectSnapshot = snapshotViewerId !== undefined ? 1 : 0
  const viewerId = snapshotViewerId ?? ''
  const rows = database
    .prepare(`
      SELECT
        c.id,
        c.author_id,
        CASE
          WHEN ? = 1 AND c.author_id <> ? AND c.status <> 'IN_REVIEW'
          THEN coalesce(latest_revision.title, c.title)
          ELSE c.title
        END AS title,
        CASE
          WHEN ? = 1 AND c.author_id <> ? AND c.status <> 'IN_REVIEW'
          THEN coalesce(latest_revision.risk, c.risk)
          ELSE c.risk
        END AS risk,
        c.status,
        c.version,
        c.created_at,
        c.updated_at,
        u.display_name AS author_name,
        rr.id AS current_round_id,
        rr.round_no AS current_round_no,
        rr.status AS round_status,
        rr.required_approvals,
        (
          SELECT count(*) FROM review_rounds history
          WHERE history.content_id = c.id
        ) AS round_count,
        coalesce((
          SELECT count(*) FROM review_decisions rd
          WHERE rd.round_id = rr.id AND rd.decision = 'APPROVE'
        ), 0) AS approval_count
      FROM contents c
      JOIN users u ON u.id = c.author_id
      LEFT JOIN review_rounds rr ON rr.id = (
        SELECT latest.id FROM review_rounds latest
        WHERE latest.content_id = c.id
        ORDER BY latest.round_no DESC LIMIT 1
      )
      LEFT JOIN content_revisions latest_revision ON latest_revision.id = rr.revision_id
      ${where}
      ORDER BY c.updated_at DESC, c.id
    `)
    .all(
      protectSnapshot,
      viewerId,
      protectSnapshot,
      viewerId,
      ...params,
    ) as unknown as SummaryRow[]
  return rows.map(toSummary)
}

function listPendingContentSummaries(
  database: DatabaseSync,
  reviewerId: string,
): ContentSummaryDto[] {
  return listContentSummaries(
    database,
    `WHERE c.status = 'IN_REVIEW'
      AND c.author_id <> ?
      AND rr.status = 'OPEN'
      AND NOT EXISTS (
        SELECT 1 FROM review_decisions mine
        WHERE mine.round_id = rr.id AND mine.reviewer_id = ?
      )`,
    [reviewerId, reviewerId],
  )
}

function listReviewedContentSummaries(
  database: DatabaseSync,
  reviewerId: string,
  protectUnsubmittedChanges = true,
): ContentSummaryDto[] {
  return listContentSummaries(
    database,
    `WHERE EXISTS (
      SELECT 1
      FROM review_decisions mine
      JOIN review_rounds participated_round ON participated_round.id = mine.round_id
      WHERE participated_round.content_id = c.id
        AND mine.reviewer_id = ?
    )`,
    [reviewerId],
    protectUnsubmittedChanges ? reviewerId : undefined,
  )
}

function buildWorkspace(
  database: DatabaseSync,
  user: CurrentUser,
): { items: WorkspaceItemDto[] } {
  const items = new Map<string, WorkspaceItemDto>()
  const addItems = (queue: WorkspaceQueue, summaries: ContentSummaryDto[]) => {
    for (const summary of summaries) {
      const existing = items.get(summary.id)
      if (existing) {
        existing.queues.push(queue)
      } else {
        items.set(summary.id, { ...summary, queues: [queue] })
      }
    }
  }

  addItems(
    'MINE',
    listContentSummaries(database, 'WHERE c.author_id = ?', [user.id]),
  )
  if (user.roles.includes('REVIEWER')) {
    addItems('PENDING_REVIEW', listPendingContentSummaries(database, user.id))
    addItems(
      'REVIEWED',
      listReviewedContentSummaries(
        database,
        user.id,
        !user.roles.includes('ADMIN'),
      ),
    )
  }
  if (user.roles.includes('ADMIN')) {
    addItems('ADMIN', listContentSummaries(database))
  }

  return {
    items: [...items.values()].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    ),
  }
}

function toSummary(row: SummaryRow): ContentSummaryDto {
  return {
    id: row.id,
    title: row.title,
    risk: row.risk,
    status: row.status,
    version: row.version,
    author: { id: row.author_id, name: row.author_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    roundCount: row.round_count,
    currentRound: row.current_round_id
      ? {
          id: row.current_round_id,
          roundNo: requireJoinedNumber(row.current_round_no, 'round number'),
          status: row.round_status as RoundStatus,
          approvalCount: row.approval_count,
          requiredApprovals: requireJoinedNumber(
            row.required_approvals,
            'required approvals',
          ),
        }
      : null,
  }
}

function requireJoinedNumber(value: number | null, field: string): number {
  if (value === null) {
    throw new Error(`Missing ${field} for joined review round`)
  }
  return value
}

function getContentDetail(
  database: DatabaseSync,
  user: CurrentUser,
  contentId: string,
): {
  content: Record<string, unknown>
  history: Array<Record<string, unknown>>
  capabilities: Record<string, boolean>
} {
  const content = requireContent(database, contentId)
  const isOwner = content.author_id === user.id
  const isAdmin = user.roles.includes('ADMIN')
  const isReviewer = user.roles.includes('REVIEWER')
  const participated = Boolean(
    database
      .prepare(`
        SELECT 1
        FROM review_decisions rd
        JOIN review_rounds rr ON rr.id = rd.round_id
        WHERE rr.content_id = ? AND rd.reviewer_id = ?
        LIMIT 1
      `)
      .get(contentId, user.id),
  )
  if (
    !isOwner &&
    !isAdmin &&
    !(isReviewer && (content.status === 'IN_REVIEW' || participated))
  ) {
    throw new ApiError(403, 'CONTENT_NOT_VISIBLE', '无权查看该内容')
  }

  const roundRows = database
    .prepare(`
      SELECT rr.*, cr.title, cr.body, cr.risk,
        cr.author_name_snapshot, cr.submitted_at
      FROM review_rounds rr
      JOIN content_revisions cr ON cr.id = rr.revision_id
      WHERE rr.content_id = ?
      ORDER BY rr.round_no DESC
    `)
    .all(contentId) as unknown as HistoryRoundRow[]

  const history = roundRows.map((round) => {
    const decisions = database
      .prepare(`
        SELECT * FROM review_decisions
        WHERE round_id = ? ORDER BY created_at, id
      `)
      .all(round.id) as unknown as DecisionRow[]
    return {
      id: round.id,
      roundNo: round.round_no,
      status: round.status,
      requiredApprovals: round.required_approvals,
      approvalCount: decisions.filter((item) => item.decision === 'APPROVE').length,
      startedAt: round.started_at,
      completedAt: round.completed_at,
      snapshot: {
        id: round.revision_id,
        title: round.title,
        body: round.body,
        risk: round.risk,
        authorName: round.author_name_snapshot,
        submittedAt: round.submitted_at,
      },
      decisions: decisions.map((decision) => ({
        id: decision.id,
        reviewer: { id: decision.reviewer_id, name: decision.reviewer_name_snapshot },
        decision: decision.decision,
        comment: decision.comment,
        createdAt: decision.created_at,
      })),
    }
  })

  const currentRound = history[0]
  const myDecision = currentRound
    ? (currentRound.decisions as Array<{ reviewer: { id: string } }>).some(
        (decision) => decision.reviewer.id === user.id,
      )
    : false
  const canReview = Boolean(
    isReviewer &&
      !isOwner &&
      content.status === 'IN_REVIEW' &&
      currentRound?.status === 'OPEN' &&
      !myDecision,
  )

  const hideUnsubmittedChanges = !isOwner && !isAdmin && content.status !== 'IN_REVIEW'
  const displayedSnapshot = hideUnsubmittedChanges ? currentRound?.snapshot : null
  const author = getUser(database, content.author_id) as CurrentUser

  return {
    content: {
      id: content.id,
      title:
        (displayedSnapshot as { title?: string } | null)?.title ?? content.title,
      body: (displayedSnapshot as { body?: string } | null)?.body ?? content.body,
      risk: (displayedSnapshot as { risk?: string } | null)?.risk ?? content.risk,
      status: content.status,
      version: content.version,
      author: { id: author.id, name: author.name },
      createdAt: content.created_at,
      updatedAt: content.updated_at,
      viewingSubmittedSnapshot: Boolean(displayedSnapshot),
    },
    history,
    capabilities: {
      canEdit:
        isOwner &&
        user.roles.includes('SUBMITTER') &&
        (content.status === 'DRAFT' || content.status === 'REJECTED'),
      canSubmit:
        isOwner &&
        user.roles.includes('SUBMITTER') &&
        (content.status === 'DRAFT' || content.status === 'REJECTED'),
      canReview,
      canViewHistory: true,
    },
  }
}