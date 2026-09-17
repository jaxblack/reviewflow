import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { ApiError } from '../errors.js'
import type { CapacityLimits } from '../limits.js'
import type {
  ContentRow,
  ContentStatus,
  CurrentUser,
  DecisionRow,
  DecisionType,
  Risk,
  Role,
  RoundStatus,
} from '../types.js'

export const USER_IDS = {
  alice: 'user-alice',
  bob: 'user-bob',
  chen: 'user-chen',
  diana: 'user-diana',
} as const

type Queryable = Pool | PoolClient
type WorkspaceQueue = 'MINE' | 'PENDING_REVIEW' | 'REVIEWED' | 'ADMIN'

export interface ContentInput {
  title: string
  body: string
  risk: Risk
}

export interface AdminUserInput {
  name: string
  roles: Role[]
}

export interface ContentSummaryDto {
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

export interface WorkspaceItemDto extends ContentSummaryDto {
  queues: WorkspaceQueue[]
}

interface SummaryRow extends QueryResultRow {
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
  round_status: RoundStatus | null
  required_approvals: number | null
  approval_count: number
  round_count: number
}

interface RoundRow extends QueryResultRow {
  id: string
  content_id: string
  revision_id: string
  round_no: number
  required_approvals: number
  status: RoundStatus
  started_at: string
  completed_at: string | null
  title: string
  body: string
  risk: Risk
  author_name_snapshot: string
  submitted_at: string
}

interface AdminUserDto extends CurrentUser {
  createdAt: string
  contentCount: number
  decisionCount: number
}

interface IdempotentResult<T> {
  statusCode: number
  body: T
  replayed: boolean
}

export class PostgresStore {
  constructor(
    readonly pool: Pool,
    private readonly limits: CapacityLimits,
  ) {}

  async close(): Promise<void> {
    await this.pool.end()
  }

  async health(): Promise<void> {
    await this.pool.query('SELECT 1')
  }

  async getUser(userId: string, database: Queryable = this.pool): Promise<CurrentUser | null> {
    const result = await database.query<{
      id: string
      display_name: string
      roles: Role[]
    }>(`
      SELECT u.id, u.display_name,
        coalesce(
          array_agg(ur.role ORDER BY ur.role) FILTER (WHERE ur.role IS NOT NULL),
          ARRAY[]::text[]
        ) AS roles
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id
    `, [userId])
    const row = result.rows[0]
    return row ? { id: row.id, name: row.display_name, roles: row.roles } : null
  }

  async listUsers(): Promise<CurrentUser[]> {
    const result = await this.pool.query<{
      id: string
      display_name: string
      roles: Role[]
    }>(`
      SELECT u.id, u.display_name,
        coalesce(
          array_agg(ur.role ORDER BY ur.role) FILTER (WHERE ur.role IS NOT NULL),
          ARRAY[]::text[]
        ) AS roles
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      GROUP BY u.id
      ORDER BY u.display_name, u.id
    `)
    return result.rows.map((row) => ({
      id: row.id,
      name: row.display_name,
      roles: row.roles,
    }))
  }

  async listAdminUsers(actorId: string): Promise<AdminUserDto[]> {
    await this.requireRole(this.pool, actorId, 'ADMIN')
    const result = await this.pool.query<{
      id: string
      display_name: string
      created_at: string
      roles: Role[]
      content_count: number
      decision_count: number
    }>(`
      SELECT u.id, u.display_name, u.created_at,
        coalesce(
          array_agg(DISTINCT ur.role ORDER BY ur.role)
            FILTER (WHERE ur.role IS NOT NULL),
          ARRAY[]::text[]
        ) AS roles,
        (SELECT count(*)::int FROM contents c WHERE c.author_id = u.id)
          AS content_count,
        (SELECT count(*)::int FROM review_decisions rd WHERE rd.reviewer_id = u.id)
          AS decision_count
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      GROUP BY u.id
      ORDER BY u.display_name, u.id
    `)
    return result.rows.map(toAdminUser)
  }

  async createUser(
    actorId: string,
    input: AdminUserInput,
    key: string,
  ): Promise<IdempotentResult<AdminUserDto>> {
    return this.withTransaction((client) => this.executeIdempotent(
      client,
      actorId,
      'CREATE_USER',
      key,
      input,
      async () => {
        await this.requireRole(client, actorId, 'ADMIN')
        await reserveCounter(client, 'users', this.limits.maxUsers, '演示用户数量已达到容量上限')
        const id = randomUUID()
        await client.query(
          'INSERT INTO users (id, display_name) VALUES ($1, $2)',
          [id, input.name],
        )
        await replaceUserRoles(client, id, input.roles)
        return { statusCode: 201, body: await getAdminUser(client, id) }
      },
    ))
  }

  async updateUser(
    actorId: string,
    userId: string,
    input: AdminUserInput,
    key: string,
  ): Promise<IdempotentResult<AdminUserDto>> {
    return this.withTransaction((client) => this.executeIdempotent(
      client,
      actorId,
      `UPDATE_USER:${userId}`,
      key,
      input,
      async () => {
        await this.requireRole(client, actorId, 'ADMIN')
        await advisoryLock(client, 'reviewflow:role-management')
        const target = await this.getUserForUpdate(client, userId)
        if (!target) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在')
        await ensureRoleChangeAllowed(client, target, input.roles)
        await client.query('UPDATE users SET display_name = $1 WHERE id = $2', [
          input.name,
          userId,
        ])
        await replaceUserRoles(client, userId, input.roles)
        return { statusCode: 200, body: await getAdminUser(client, userId) }
      },
    ))
  }

  async buildWorkspace(actor: CurrentUser): Promise<{ items: WorkspaceItemDto[] }> {
    const items = await this.listVisibleSummaries(actor)
    return { items }
  }

  async listMine(actor: CurrentUser): Promise<ContentSummaryDto[]> {
    await this.requireRole(this.pool, actor.id, 'SUBMITTER')
    return this.listSummaries('WHERE c.author_id = $1', [actor.id])
  }

  async listAll(actor: CurrentUser): Promise<ContentSummaryDto[]> {
    await this.requireRole(this.pool, actor.id, 'ADMIN')
    return this.listSummaries()
  }

  async listPending(actor: CurrentUser): Promise<ContentSummaryDto[]> {
    await this.requireRole(this.pool, actor.id, 'REVIEWER')
    return this.listSummaries(`
      WHERE c.status = 'IN_REVIEW'
        AND c.author_id <> $1
        AND rr.status = 'OPEN'
        AND NOT EXISTS (
          SELECT 1 FROM review_decisions mine
          WHERE mine.round_id = rr.id AND mine.reviewer_id = $1
        )
    `, [actor.id])
  }

  async createContent(
    actorId: string,
    input: ContentInput,
    key: string,
  ): Promise<IdempotentResult<unknown>> {
    return this.withTransaction((client) => this.executeIdempotent(
      client,
      actorId,
      'CREATE_CONTENT',
      key,
      input,
      async () => {
        const actor = await this.requireRole(client, actorId, 'SUBMITTER')
        await reserveCounter(client, 'contents', this.limits.maxContents, '内容数量已达到容量上限')
        const id = randomUUID()
        await client.query(`
          INSERT INTO contents (
            id, author_id, title, body, risk, status, version
          ) VALUES ($1, $2, $3, $4, $5, 'DRAFT', 1)
        `, [id, actor.id, input.title, input.body, input.risk])
        return { statusCode: 201, body: await this.getContentDetail(actor, id, client) }
      },
    ))
  }

  async editContent(
    actorId: string,
    contentId: string,
    input: ContentInput & { expectedVersion: number },
    key: string,
  ): Promise<IdempotentResult<unknown>> {
    return this.withTransaction((client) => this.executeIdempotent(
      client,
      actorId,
      `EDIT_CONTENT:${contentId}`,
      key,
      input,
      async () => {
        const actor = await this.requireRole(client, actorId, 'SUBMITTER')
        const content = await requireContent(client, contentId, true)
        requireAuthor(actor, content)
        requireEditable(content, input.expectedVersion, '编辑')
        await client.query(`
          UPDATE contents
          SET title = $1, body = $2, risk = $3,
              version = version + 1, updated_at = now()
          WHERE id = $4
        `, [input.title, input.body, input.risk, contentId])
        return { statusCode: 200, body: await this.getContentDetail(actor, contentId, client) }
      },
    ))
  }

  async submitContent(
    actorId: string,
    contentId: string,
    expectedVersion: number,
    key: string,
  ): Promise<IdempotentResult<unknown>> {
    return this.withTransaction((client) => this.executeIdempotent(
      client,
      actorId,
      `SUBMIT_CONTENT:${contentId}`,
      key,
      { expectedVersion },
      async () => {
        const actor = await this.requireRole(client, actorId, 'SUBMITTER')
        await advisoryLock(client, 'reviewflow:role-management')
        const content = await requireContent(client, contentId, true)
        requireAuthor(actor, content)
        requireEditable(content, expectedVersion, '提交')
        const requiredApprovals = content.risk === 'LOW' ? 1 : 2
        const eligible = await client.query<{ count: number }>(`
          SELECT count(DISTINCT user_id)::int AS count
          FROM user_roles
          WHERE role = 'REVIEWER' AND user_id <> $1
        `, [content.author_id])
        if (eligible.rows[0].count < requiredApprovals) {
          throw new ApiError(422, 'INSUFFICIENT_REVIEWERS', '当前没有足够的合法审核人')
        }
        const roundCount = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM review_rounds WHERE content_id = $1',
          [contentId],
        )
        if (roundCount.rows[0].count >= this.limits.maxRoundsPerContent) {
          throw new ApiError(507, 'CAPACITY_LIMIT_REACHED', '该内容的审核轮次数已达到容量上限')
        }
        const roundNo = roundCount.rows[0].count + 1
        const revisionId = randomUUID()
        const roundId = randomUUID()
        await client.query(`
          INSERT INTO content_revisions (
            id, content_id, revision_no, title, body, risk,
            author_id, author_name_snapshot
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          revisionId,
          contentId,
          roundNo,
          content.title,
          content.body,
          content.risk,
          content.author_id,
          actor.name,
        ])
        await client.query(`
          INSERT INTO review_rounds (
            id, content_id, revision_id, round_no, required_approvals, status
          ) VALUES ($1, $2, $3, $4, $5, 'OPEN')
        `, [roundId, contentId, revisionId, roundNo, requiredApprovals])
        await client.query(`
          UPDATE contents
          SET status = 'IN_REVIEW', version = version + 1, updated_at = now()
          WHERE id = $1
        `, [contentId])
        return { statusCode: 201, body: await this.getContentDetail(actor, contentId, client) }
      },
    ))
  }

  async decide(
    actorId: string,
    roundId: string,
    input: { decision: DecisionType; comment: string | null },
    key: string,
  ): Promise<IdempotentResult<unknown>> {
    return this.withTransaction((client) => this.executeIdempotent(
      client,
      actorId,
      `REVIEW_DECISION:${roundId}`,
      key,
      input,
      async () => {
        const actor = await this.requireRole(client, actorId, 'REVIEWER')
        const roundReference = await client.query<{ content_id: string }>(
          'SELECT content_id FROM review_rounds WHERE id = $1',
          [roundId],
        )
        if (!roundReference.rows[0]) {
          throw new ApiError(404, 'ROUND_NOT_FOUND', '审核轮次不存在')
        }
        const content = await requireContent(
          client,
          roundReference.rows[0].content_id,
          true,
        )
        const roundResult = await client.query<{
          id: string
          content_id: string
          status: RoundStatus
          required_approvals: number
        }>('SELECT * FROM review_rounds WHERE id = $1 FOR UPDATE', [roundId])
        const round = roundResult.rows[0]
        if (content.author_id === actor.id) {
          throw new ApiError(409, 'SELF_REVIEW_FORBIDDEN', '不能审核自己创建的内容')
        }
        const previous = await client.query<DecisionRow>(`
          SELECT * FROM review_decisions
          WHERE round_id = $1 AND reviewer_id = $2
        `, [roundId, actor.id])
        if (previous.rows[0]) {
          const existing = previous.rows[0]
          if (existing.decision === input.decision && existing.comment === input.comment) {
            return {
              statusCode: 200,
              body: await this.getContentDetail(actor, content.id, client),
            }
          }
          throw new ApiError(409, 'ALREADY_DECIDED', '本轮已经做出审核决定')
        }
        if (round.status !== 'OPEN' || content.status !== 'IN_REVIEW') {
          throw new ApiError(409, 'ROUND_CLOSED', '审核轮次已经结束')
        }
        await client.query(`
          INSERT INTO review_decisions (
            id, round_id, reviewer_id, reviewer_name_snapshot, decision, comment
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [randomUUID(), roundId, actor.id, actor.name, input.decision, input.comment])
        let finalStatus: 'APPROVED' | 'REJECTED' | null = null
        if (input.decision === 'REJECT') {
          finalStatus = 'REJECTED'
        } else {
          const approvals = await client.query<{ count: number }>(`
            SELECT count(*)::int AS count FROM review_decisions
            WHERE round_id = $1 AND decision = 'APPROVE'
          `, [roundId])
          if (approvals.rows[0].count >= round.required_approvals) {
            finalStatus = 'APPROVED'
          }
        }
        if (finalStatus) {
          const closed = await client.query(`
            UPDATE review_rounds
            SET status = $1, completed_at = now()
            WHERE id = $2 AND status = 'OPEN'
          `, [finalStatus, roundId])
          if (closed.rowCount !== 1) {
            throw new ApiError(409, 'ROUND_CLOSED', '审核轮次已经结束')
          }
        }
        const updated = await client.query(`
          UPDATE contents
          SET status = coalesce($1, status),
              version = version + 1,
              updated_at = now()
          WHERE id = $2 AND status = 'IN_REVIEW'
        `, [finalStatus, content.id])
        if (updated.rowCount !== 1) {
          throw new ApiError(409, 'INVALID_STATE', '内容状态已经变化')
        }
        return { statusCode: 200, body: await this.getContentDetail(actor, content.id, client) }
      },
    ))
  }

  async getContentDetail(
    actor: CurrentUser,
    contentId: string,
    database: Queryable = this.pool,
  ): Promise<{
    content: Record<string, unknown>
    history: Array<Record<string, unknown>>
    capabilities: Record<string, boolean>
  }> {
    const contentResult = await database.query<ContentRow & { author_name: string }>(`
      SELECT c.*, u.display_name AS author_name
      FROM contents c JOIN users u ON u.id = c.author_id
      WHERE c.id = $1
    `, [contentId])
    const content = contentResult.rows[0]
    if (!content) throw new ApiError(404, 'CONTENT_NOT_FOUND', '内容不存在')
    const isOwner = content.author_id === actor.id
    const isAdmin = actor.roles.includes('ADMIN')
    const isReviewer = actor.roles.includes('REVIEWER')
    const participation = await database.query(`
      SELECT 1
      FROM review_decisions rd
      JOIN review_rounds rr ON rr.id = rd.round_id
      WHERE rr.content_id = $1 AND rd.reviewer_id = $2
      LIMIT 1
    `, [contentId, actor.id])
    const participated = Boolean(participation.rowCount)
    if (!isOwner && !isAdmin && !(isReviewer && (content.status === 'IN_REVIEW' || participated))) {
      throw new ApiError(403, 'CONTENT_NOT_VISIBLE', '无权查看该内容')
    }

    const rounds = await database.query<RoundRow>(`
      SELECT rr.*, cr.title, cr.body, cr.risk,
        cr.author_name_snapshot, cr.submitted_at
      FROM review_rounds rr
      JOIN content_revisions cr ON cr.id = rr.revision_id
      WHERE rr.content_id = $1
      ORDER BY rr.round_no DESC
    `, [contentId])
    const decisions = rounds.rows.length === 0
      ? []
      : (await database.query<DecisionRow>(`
          SELECT rd.*
          FROM review_decisions rd
          JOIN review_rounds rr ON rr.id = rd.round_id
          WHERE rr.content_id = $1
          ORDER BY rd.created_at, rd.id
        `, [contentId])).rows
    const decisionsByRound = new Map<string, DecisionRow[]>()
    for (const decision of decisions) {
      const current = decisionsByRound.get(decision.round_id) ?? []
      current.push(decision)
      decisionsByRound.set(decision.round_id, current)
    }
    const history = rounds.rows.map((round) => {
      const roundDecisions = decisionsByRound.get(round.id) ?? []
      return {
        id: round.id,
        roundNo: round.round_no,
        status: round.status,
        requiredApprovals: round.required_approvals,
        approvalCount: roundDecisions.filter((item) => item.decision === 'APPROVE').length,
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
        decisions: roundDecisions.map((decision) => ({
          id: decision.id,
          reviewer: {
            id: decision.reviewer_id,
            name: decision.reviewer_name_snapshot,
          },
          decision: decision.decision,
          comment: decision.comment,
          createdAt: decision.created_at,
        })),
      }
    })
    const currentRound = history[0]
    const myDecision = currentRound?.decisions.some(
      (decision) => decision.reviewer.id === actor.id,
    ) ?? false
    const canReview = Boolean(
      isReviewer &&
      !isOwner &&
      content.status === 'IN_REVIEW' &&
      currentRound?.status === 'OPEN' &&
      !myDecision,
    )
    const hideUnsubmittedChanges = !isOwner && !isAdmin && content.status !== 'IN_REVIEW'
    const displayedSnapshot = hideUnsubmittedChanges ? currentRound?.snapshot : null
    return {
      content: {
        id: content.id,
        title: displayedSnapshot?.title ?? content.title,
        body: displayedSnapshot?.body ?? content.body,
        risk: displayedSnapshot?.risk ?? content.risk,
        status: content.status,
        version: content.version,
        author: { id: content.author_id, name: content.author_name },
        createdAt: content.created_at,
        updatedAt: content.updated_at,
        viewingSubmittedSnapshot: Boolean(displayedSnapshot),
      },
      history,
      capabilities: {
        canEdit: isOwner && actor.roles.includes('SUBMITTER') && isEditableStatus(content.status),
        canSubmit: isOwner && actor.roles.includes('SUBMITTER') && isEditableStatus(content.status),
        canReview,
        canViewHistory: true,
      },
    }
  }

  private async listVisibleSummaries(actor: CurrentUser): Promise<WorkspaceItemDto[]> {
    const isReviewer = actor.roles.includes('REVIEWER')
    const isAdmin = actor.roles.includes('ADMIN')
    const result = await this.pool.query<SummaryRow & {
      is_mine: boolean
      is_pending: boolean
      is_reviewed: boolean
    }>(`${summarySelect(`
      CASE
        WHEN $2::boolean AND c.author_id <> $1 AND c.status <> 'IN_REVIEW'
        THEN coalesce(latest_revision.title, c.title)
        ELSE c.title
      END,
      CASE
        WHEN $2::boolean AND c.author_id <> $1 AND c.status <> 'IN_REVIEW'
        THEN coalesce(latest_revision.risk, c.risk)
        ELSE c.risk
      END
    `)},
      (c.author_id = $1) AS is_mine,
      ($3::boolean AND c.status = 'IN_REVIEW' AND c.author_id <> $1
        AND rr.status = 'OPEN'
        AND NOT EXISTS (
          SELECT 1 FROM review_decisions pending_mine
          WHERE pending_mine.round_id = rr.id AND pending_mine.reviewer_id = $1
        )) AS is_pending,
      ($3::boolean AND EXISTS (
        SELECT 1 FROM review_decisions reviewed_mine
        JOIN review_rounds reviewed_round ON reviewed_round.id = reviewed_mine.round_id
        WHERE reviewed_round.content_id = c.id AND reviewed_mine.reviewer_id = $1
      )) AS is_reviewed
      FROM contents c
      JOIN users u ON u.id = c.author_id
      LEFT JOIN LATERAL (
        SELECT latest.* FROM review_rounds latest
        WHERE latest.content_id = c.id
        ORDER BY latest.round_no DESC LIMIT 1
      ) rr ON true
      LEFT JOIN content_revisions latest_revision ON latest_revision.id = rr.revision_id
      WHERE c.author_id = $1
        OR $4::boolean
        OR ($3::boolean AND c.status = 'IN_REVIEW' AND c.author_id <> $1)
        OR ($3::boolean AND EXISTS (
          SELECT 1 FROM review_decisions visible_mine
          JOIN review_rounds visible_round ON visible_round.id = visible_mine.round_id
          WHERE visible_round.content_id = c.id AND visible_mine.reviewer_id = $1
        ))
      ORDER BY c.updated_at DESC, c.id
    `, [actor.id, isReviewer && !isAdmin, isReviewer, isAdmin])
    return result.rows.map((row) => {
      const queues: WorkspaceQueue[] = []
      if (row.is_mine) queues.push('MINE')
      if (row.is_pending) queues.push('PENDING_REVIEW')
      if (row.is_reviewed) queues.push('REVIEWED')
      if (isAdmin) queues.push('ADMIN')
      return { ...toSummary(row), queues }
    })
  }

  private async listSummaries(
    where = '',
    params: unknown[] = [],
  ): Promise<ContentSummaryDto[]> {
    const result = await this.pool.query<SummaryRow>(`
      ${summarySelect('c.title, c.risk')}
      FROM contents c
      JOIN users u ON u.id = c.author_id
      LEFT JOIN LATERAL (
        SELECT latest.* FROM review_rounds latest
        WHERE latest.content_id = c.id
        ORDER BY latest.round_no DESC LIMIT 1
      ) rr ON true
      LEFT JOIN content_revisions latest_revision ON latest_revision.id = rr.revision_id
      ${where}
      ORDER BY c.updated_at DESC, c.id
    `, params)
    return result.rows.map(toSummary)
  }

  private async getUserForUpdate(
    client: PoolClient,
    userId: string,
  ): Promise<CurrentUser | null> {
    const locked = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
    return locked.rowCount ? this.getUser(userId, client) : null
  }

  private async requireRole(
    database: Queryable,
    userId: string,
    role: Role,
  ): Promise<CurrentUser> {
    const user = await this.getUser(userId, database)
    if (!user) throw new ApiError(401, 'INVALID_SESSION', '用户会话无效')
    if (!user.roles.includes(role)) {
      throw new ApiError(403, 'ROLE_REQUIRED', `需要 ${role} 角色`)
    }
    return user
  }

  private async executeIdempotent<T>(
    client: PoolClient,
    actorId: string,
    operation: string,
    key: string,
    requestBody: unknown,
    action: () => Promise<{ statusCode: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    await advisoryLock(client, `reviewflow:idempotency:${actorId}:${operation}:${key}`)
    await cleanupExpiredIdempotency(client, this.limits.idempotencyTtlHours)
    const requestHash = createHash('sha256')
      .update(JSON.stringify(requestBody))
      .digest('hex')
    const previous = await client.query<{
      request_hash: string
      status_code: number
      response_body: T
    }>(`
      SELECT request_hash, status_code, response_body
      FROM idempotency_requests
      WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3
    `, [actorId, operation, key])
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '幂等键已经用于不同请求')
      }
      return {
        statusCode: previous.rows[0].status_code,
        body: previous.rows[0].response_body,
        replayed: true,
      }
    }
    await reserveCounter(
      client,
      'idempotency',
      this.limits.maxIdempotencyRecords,
      '幂等请求记录已达到容量上限，请稍后重试',
    )
    const result = await action()
    await client.query(`
      INSERT INTO idempotency_requests (
        actor_id, operation, idempotency_key, request_hash,
        status_code, response_body
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `, [
      actorId,
      operation,
      key,
      requestHash,
      result.statusCode,
      JSON.stringify(result.body),
    ])
    return { ...result, replayed: false }
  }

  private async withTransaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '5s'")
      await client.query("SET LOCAL statement_timeout = '15s'")
      const result = await action(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw mapPostgresError(error)
    } finally {
      client.release()
    }
  }
}

function summarySelect(titleAndRisk: string): string {
  return `
    SELECT c.id, c.author_id,
      ${titleAndRisk},
      c.status, c.version, c.created_at, c.updated_at,
      u.display_name AS author_name,
      rr.id AS current_round_id,
      rr.round_no AS current_round_no,
      rr.status AS round_status,
      rr.required_approvals,
      (SELECT count(*)::int FROM review_rounds history WHERE history.content_id = c.id)
        AS round_count,
      coalesce((
        SELECT count(*)::int FROM review_decisions rd
        WHERE rd.round_id = rr.id AND rd.decision = 'APPROVE'
      ), 0) AS approval_count
  `
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
          roundNo: requireNumber(row.current_round_no, 'round number'),
          status: row.round_status as RoundStatus,
          approvalCount: row.approval_count,
          requiredApprovals: requireNumber(
            row.required_approvals,
            'required approvals',
          ),
        }
      : null,
  }
}

function toAdminUser(row: {
  id: string
  display_name: string
  roles: Role[]
  created_at: string
  content_count: number
  decision_count: number
}): AdminUserDto {
  return {
    id: row.id,
    name: row.display_name,
    roles: row.roles,
    createdAt: row.created_at,
    contentCount: row.content_count,
    decisionCount: row.decision_count,
  }
}

async function getAdminUser(database: Queryable, userId: string): Promise<AdminUserDto> {
  const result = await database.query<{
    id: string
    display_name: string
    roles: Role[]
    created_at: string
    content_count: number
    decision_count: number
  }>(`
    SELECT u.id, u.display_name, u.created_at,
      coalesce(
        array_agg(ur.role ORDER BY ur.role) FILTER (WHERE ur.role IS NOT NULL),
        ARRAY[]::text[]
      ) AS roles,
      (SELECT count(*)::int FROM contents c WHERE c.author_id = u.id) AS content_count,
      (SELECT count(*)::int FROM review_decisions rd WHERE rd.reviewer_id = u.id)
        AS decision_count
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    WHERE u.id = $1
    GROUP BY u.id
  `, [userId])
  if (!result.rows[0]) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在')
  return toAdminUser(result.rows[0])
}

async function requireContent(
  database: Queryable,
  contentId: string,
  lock = false,
): Promise<ContentRow> {
  const result = await database.query<ContentRow>(
    `SELECT * FROM contents WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [contentId],
  )
  if (!result.rows[0]) throw new ApiError(404, 'CONTENT_NOT_FOUND', '内容不存在')
  return result.rows[0]
}

function requireAuthor(actor: CurrentUser, content: ContentRow): void {
  if (content.author_id !== actor.id) {
    throw new ApiError(403, 'AUTHOR_REQUIRED', '只有内容作者可以执行此操作')
  }
}

function requireEditable(
  content: ContentRow,
  expectedVersion: number,
  action: '编辑' | '提交',
): void {
  if (!isEditableStatus(content.status)) {
    throw new ApiError(409, 'INVALID_STATE', `当前状态不允许${action}`)
  }
  if (content.version !== expectedVersion) {
    throw new ApiError(409, 'STALE_VERSION', '内容已更新，请刷新后重试')
  }
}

function isEditableStatus(status: ContentStatus): boolean {
  return status === 'DRAFT' || status === 'REJECTED'
}

async function replaceUserRoles(
  client: PoolClient,
  userId: string,
  roles: Role[],
): Promise<void> {
  await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId])
  await client.query(`
    INSERT INTO user_roles (user_id, role)
    SELECT $1, role
    FROM unnest($2::text[]) AS role
  `, [userId, roles])
}

async function ensureRoleChangeAllowed(
  client: PoolClient,
  target: CurrentUser,
  nextRoles: Role[],
): Promise<void> {
  if (target.roles.includes('ADMIN') && !nextRoles.includes('ADMIN')) {
    const admins = await client.query<{ count: number }>(`
      SELECT count(DISTINCT user_id)::int AS count
      FROM user_roles WHERE role = 'ADMIN'
    `)
    if (admins.rows[0].count <= 1) {
      throw new ApiError(409, 'LAST_ADMIN_REQUIRED', '系统必须至少保留一位管理员')
    }
  }
  if (target.roles.includes('REVIEWER') && !nextRoles.includes('REVIEWER')) {
    const blocked = await client.query(`
      SELECT rr.id
      FROM review_rounds rr
      JOIN contents c ON c.id = rr.content_id
      WHERE rr.status = 'OPEN'
        AND c.author_id <> $1
        AND (
          SELECT count(DISTINCT ur.user_id)::int
          FROM user_roles ur
          WHERE ur.role = 'REVIEWER'
            AND ur.user_id <> c.author_id
            AND ur.user_id <> $1
            AND NOT EXISTS (
              SELECT 1 FROM review_decisions decided
              WHERE decided.round_id = rr.id AND decided.reviewer_id = ur.user_id
            )
        ) < (
          rr.required_approvals - (
            SELECT count(*)::int FROM review_decisions approved
            WHERE approved.round_id = rr.id AND approved.decision = 'APPROVE'
          )
        )
      LIMIT 1
    `, [target.id])
    if (blocked.rowCount) {
      throw new ApiError(
        409,
        'ROLE_CHANGE_WOULD_BLOCK_OPEN_ROUND',
        '该角色仍是进行中审核所需的合法审核人',
      )
    }
  }
}

async function reserveCounter(
  client: PoolClient,
  resource: 'users' | 'contents' | 'idempotency',
  limit: number,
  message: string,
): Promise<void> {
  const reserved = await client.query(`
    UPDATE capacity_counters
    SET used = used + 1
    WHERE resource = $1 AND used < $2
    RETURNING used
  `, [resource, limit])
  if (reserved.rowCount !== 1) {
    throw new ApiError(507, 'CAPACITY_LIMIT_REACHED', message)
  }
}

async function cleanupExpiredIdempotency(
  client: PoolClient,
  ttlHours: number,
): Promise<void> {
  await client.query(`
    WITH deleted AS (
      DELETE FROM idempotency_requests
      WHERE created_at < now() - ($1::double precision * interval '1 hour')
      RETURNING 1
    )
    UPDATE capacity_counters
    SET used = greatest(used - (SELECT count(*) FROM deleted), 0)
    WHERE resource = 'idempotency'
  `, [ttlHours])
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
}

function requireNumber(value: number | null, field: string): number {
  if (value === null) throw new Error(`Missing ${field} for joined review round`)
  return value
}

function mapPostgresError(error: unknown): unknown {
  const postgresError = error as {
    code?: string
    constraint?: string
    message?: string
  }
  if (postgresError.code === '23505') {
    if (postgresError.constraint === 'users_display_name_unique') {
      return new ApiError(409, 'USER_NAME_EXISTS', '用户名称已经存在')
    }
    if (
      postgresError.constraint === 'review_decisions_round_id_reviewer_id_key'
    ) {
      return new ApiError(409, 'ALREADY_DECIDED', '本轮已经做出审核决定')
    }
    if (postgresError.constraint === 'review_rounds_one_open_per_content') {
      return new ApiError(409, 'INVALID_STATE', '该内容已经存在开放审核轮次')
    }
  }
  if (postgresError.code === '55P03' || postgresError.code === '57014') {
    return new ApiError(409, 'CONCURRENT_UPDATE', '并发操作冲突，请刷新后重试')
  }
  return error
}