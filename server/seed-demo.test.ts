import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { USER_IDS } from './postgres/store.js'
import { seedDemoData } from './seed-demo.js'
import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from './test/postgres.js'

const describePostgres = hasPostgresTestDatabase() ? describe : describe.skip

describePostgres('PostgreSQL demo data seed', () => {
  let database: Pool
  let testDatabase: PostgresTestDatabase

  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase('seed')
    database = testDatabase.pool
  }, 20_000)

  beforeEach(async () => testDatabase.reset())
  afterAll(async () => testDatabase.close())

  it('creates core scenarios and a realistic queue exactly once', async () => {
    await expect(seedDemoData(database, Date.UTC(2026, 8, 17, 12))).resolves.toEqual({
      insertedContents: 56,
      totalDemoContents: 56,
    })
    await expect(seedDemoData(database, Date.UTC(2026, 8, 17, 13))).resolves.toEqual({
      insertedContents: 0,
      totalDemoContents: 56,
    })

    const statuses = await database.query(`
      SELECT status, count(*)::int AS count FROM contents
      WHERE id LIKE 'demo-%' GROUP BY status ORDER BY status
    `)
    expect(statuses.rows).toEqual([
      { status: 'APPROVED', count: 19 },
      { status: 'DRAFT', count: 9 },
      { status: 'IN_REVIEW', count: 19 },
      { status: 'REJECTED', count: 9 },
    ])

    const risks = await database.query(`
      SELECT risk, count(*)::int AS count FROM contents
      WHERE id LIKE 'demo-%' GROUP BY risk ORDER BY risk
    `)
    expect(risks.rows).toEqual([
      { risk: 'HIGH', count: 26 },
      { risk: 'LOW', count: 30 },
    ])

    const rounds = await database.query(`
      SELECT rr.round_no, rr.status, cr.title
      FROM review_rounds rr JOIN content_revisions cr ON cr.id = rr.revision_id
      WHERE rr.content_id = 'demo-resubmitted' ORDER BY rr.round_no
    `)
    expect(rounds.rows).toEqual([
      { round_no: 1, status: 'REJECTED', title: '用户通知模板（初稿）' },
      { round_no: 2, status: 'APPROVED', title: '用户通知模板（修订版）' },
    ])
  })

  it('keeps pending progress and terminal decisions consistent', async () => {
    await seedDemoData(database)
    const pending = await database.query(`
      SELECT rr.status, rr.required_approvals,
        count(rd.*) FILTER (WHERE rd.decision = 'APPROVE')::int AS approvals
      FROM review_rounds rr LEFT JOIN review_decisions rd ON rd.round_id = rr.id
      WHERE rr.id = 'demo-high-pending-round-1' GROUP BY rr.id
    `)
    expect(pending.rows[0]).toEqual({
      status: 'OPEN',
      required_approvals: 2,
      approvals: 1,
    })

    const invalid = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM review_decisions rd
      JOIN review_rounds rr ON rr.id = rd.round_id
      JOIN contents c ON c.id = rr.content_id
      WHERE rd.reviewer_id = c.author_id
    `)
    expect(invalid.rows[0].count).toBe(0)

    const terminalCount = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM review_decisions
      WHERE round_id = 'demo-concurrent-terminal-round-1'
    `)
    expect(terminalCount.rows[0].count).toBe(1)

    const pendingFor = async (reviewerId: string): Promise<number> => {
      const result = await database.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM review_rounds rr
        JOIN contents c ON c.id = rr.content_id
        WHERE rr.status = 'OPEN'
          AND c.status = 'IN_REVIEW'
          AND c.author_id <> $1
          AND NOT EXISTS (
            SELECT 1 FROM review_decisions mine
            WHERE mine.round_id = rr.id AND mine.reviewer_id = $1
          )
      `, [reviewerId])
      return result.rows[0].count
    }

    await expect(Promise.all([
      pendingFor(USER_IDS.alice),
      pendingFor(USER_IDS.bob),
      pendingFor(USER_IDS.chen),
    ])).resolves.toEqual([0, 15, 19])
  })
})