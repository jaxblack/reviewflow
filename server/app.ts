import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { z, ZodError } from 'zod'
import { ApiError } from './errors.js'
import {
  resolveCapacityLimits,
  type CapacityLimits,
} from './limits.js'
import { migratePostgres } from './postgres/migrate.js'
import { createPostgresPool } from './postgres/pool.js'
import {
  PostgresStore,
  USER_IDS,
  type AdminUserInput,
  type ContentInput,
} from './postgres/store.js'
import type { CurrentUser, DecisionType, Role } from './types.js'

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

interface BuildAppOptions {
  pool?: Pool
  databaseUrl?: string
  migrate?: boolean
  logger?: boolean
  serveStatic?: boolean
  sessionSecret?: string
  capacityLimits?: Partial<CapacityLimits>
  writeRateLimitMax?: number
  beforeWriteRequest?: (request: FastifyRequest) => void | Promise<void>
}

interface IdempotentHttpResult<T> {
  statusCode: number
  body: T
  replayed: boolean
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const ownsPool = options.pool === undefined
  const pool = options.pool ?? createPostgresPool(options.databaseUrl)
  if (options.migrate ?? true) await migratePostgres(pool)
  const store = new PostgresStore(pool, resolveCapacityLimits(options.capacityLimits))
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: ['127.0.0.1', '::1'],
  })
  const configuredSessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET
  if (!configuredSessionSecret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production')
  }
  const sessionSecret =
    configuredSessionSecret ?? 'reviewflow-local-session-secret-change-me'
  const writeRateLimitMax = resolvePositiveInteger(
    options.writeRateLimitMax,
    process.env.REVIEWFLOW_WRITE_RATE_LIMIT,
    30,
    'REVIEWFLOW_WRITE_RATE_LIMIT',
  )

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
    onRequest: app.rateLimit({ max: writeRateLimitMax, timeWindow: 60_000 }),
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
    const nested = error as unknown as {
      statusCode?: number
      error?: { code?: string; message?: string }
    }
    if (nested.statusCode === 429 && nested.error?.code === 'RATE_LIMITED') {
      return reply.status(429).send({ error: nested.error })
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

  app.addHook('onClose', async () => {
    if (ownsPool) await store.close()
  })

  app.get('/api/health', async () => {
    await store.health()
    return { status: 'ok', database: 'postgresql' }
  })
  app.get('/api/users', () => store.listUsers())
  app.get('/api/me', async (request) => getCurrentUser(store, request))

  app.get('/api/admin/users', async (request) => {
    const actor = await getCurrentUser(store, request)
    return store.listAdminUsers(actor.id)
  })

  app.post('/api/admin/users', writeRouteOptions, async (request, reply) => {
    const actor = await getCurrentUser(store, request)
    const parsed = adminUserInputSchema.parse(request.body)
    const input: AdminUserInput = {
      ...parsed,
      roles: [...parsed.roles].sort() as Role[],
    }
    return sendIdempotent(
      reply,
      await store.createUser(actor.id, input, getIdempotencyKey(request)),
    )
  })

  app.patch('/api/admin/users/:id', writeRouteOptions, async (request, reply) => {
    const actor = await getCurrentUser(store, request)
    const { id } = idParamsSchema.parse(request.params)
    const parsed = adminUserInputSchema.parse(request.body)
    const input: AdminUserInput = {
      ...parsed,
      roles: [...parsed.roles].sort() as Role[],
    }
    return sendIdempotent(
      reply,
      await store.updateUser(actor.id, id, input, getIdempotencyKey(request)),
    )
  })

  app.get('/api/workspace', async (request) => {
    const actor = await getCurrentUser(store, request)
    return store.buildWorkspace(actor)
  })

  app.post('/api/session/switch', writeRouteOptions, async (request, reply) => {
    const input = switchUserSchema.parse(request.body)
    const user = await store.getUser(input.userId)
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

  app.get('/api/contents', async (request) => {
    const actor = await getCurrentUser(store, request)
    const query = contentListQuerySchema.parse(request.query)
    return query.scope === 'all' ? store.listAll(actor) : store.listMine(actor)
  })

  app.post('/api/contents', writeRouteOptions, async (request, reply) => {
    const actor = await getCurrentUser(store, request)
    const input = contentInputSchema.parse(request.body) as ContentInput
    return sendIdempotent(
      reply,
      await store.createContent(actor.id, input, getIdempotencyKey(request)),
    )
  })

  app.get('/api/contents/:id', async (request) => {
    const actor = await getCurrentUser(store, request)
    const { id } = idParamsSchema.parse(request.params)
    return store.getContentDetail(actor, id)
  })

  app.get('/api/contents/:id/history', async (request) => {
    const actor = await getCurrentUser(store, request)
    const { id } = idParamsSchema.parse(request.params)
    return (await store.getContentDetail(actor, id)).history
  })

  app.patch('/api/contents/:id', writeRouteOptions, async (request, reply) => {
    const actor = await getCurrentUser(store, request)
    const { id } = idParamsSchema.parse(request.params)
    const input = editContentSchema.parse(request.body)
    return sendIdempotent(
      reply,
      await store.editContent(actor.id, id, input, getIdempotencyKey(request)),
    )
  })

  app.post('/api/contents/:id/submit', writeRouteOptions, async (request, reply) => {
    const actor = await getCurrentUser(store, request)
    const { id } = idParamsSchema.parse(request.params)
    const input = submitContentSchema.parse(request.body)
    return sendIdempotent(
      reply,
      await store.submitContent(
        actor.id,
        id,
        input.expectedVersion,
        getIdempotencyKey(request),
      ),
    )
  })

  app.get('/api/reviews/pending', async (request) => {
    const actor = await getCurrentUser(store, request)
    return store.listPending(actor)
  })

  app.post(
    '/api/review-rounds/:id/decisions',
    writeRouteOptions,
    async (request, reply) => {
      const actor = await getCurrentUser(store, request)
      const { id } = idParamsSchema.parse(request.params)
      const parsed = decisionSchema.parse(request.body)
      const input: { decision: DecisionType; comment: string | null } = {
        decision: parsed.decision,
        comment: parsed.comment?.trim() || null,
      }
      if (input.decision === 'REJECT' && !input.comment) {
        throw new ApiError(
          422,
          'REJECTION_REASON_REQUIRED',
          '拒绝时必须填写理由',
        )
      }
      return sendIdempotent(
        reply,
        await store.decide(actor.id, id, input, getIdempotencyKey(request)),
      )
    },
  )

  if (options.serveStatic) {
    const staticRoot = join(process.cwd(), 'dist')
    if (existsSync(staticRoot)) {
      await app.register(fastifyStatic, { root: staticRoot })
    }
  }
  return app
}

async function getCurrentUser(
  store: PostgresStore,
  request: FastifyRequest,
): Promise<CurrentUser> {
  const cookieValue = request.cookies.reviewflow_user
  let userId: string = USER_IDS.alice
  if (cookieValue) {
    const unsigned = request.unsignCookie(cookieValue)
    if (!unsigned.valid) {
      throw new ApiError(401, 'INVALID_SESSION', '用户会话无效')
    }
    userId = unsigned.value
  }
  const user = await store.getUser(userId)
  if (!user) throw new ApiError(401, 'INVALID_SESSION', '用户会话无效')
  return user
}

function sendIdempotent<T>(
  reply: FastifyReply,
  result: IdempotentHttpResult<T>,
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

function resolvePositiveInteger(
  override: number | undefined,
  environmentValue: string | undefined,
  fallback: number,
  name: string,
): number {
  const value = override ?? (
    environmentValue === undefined ? fallback : Number(environmentValue)
  )
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}