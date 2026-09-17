import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, USER_IDS } from './db.js'
import { seedDemoData } from './seed-demo.js'

describe('demo data seed', () => {
  let database: DatabaseSync

  beforeEach(() => {
    database = createDatabase(':memory:')
  })

  afterEach(() => database.close())

  it('creates core scenarios and a realistic queue exactly once', () => {
    expect(seedDemoData(database, Date.UTC(2026, 8, 17, 12))).toEqual({
      insertedContents: 56,
      totalDemoContents: 56,
    })
    expect(seedDemoData(database, Date.UTC(2026, 8, 17, 13))).toEqual({
      insertedContents: 0,
      totalDemoContents: 56,
    })

    const statuses = database.prepare(`
      SELECT status, count(*) AS count FROM contents
      WHERE id LIKE 'demo-%' GROUP BY status ORDER BY status
    `).all()
    expect(statuses).toEqual([
      { status: 'APPROVED', count: 19 },
      { status: 'DRAFT', count: 9 },
      { status: 'IN_REVIEW', count: 19 },
      { status: 'REJECTED', count: 9 },
    ])

    const risks = database.prepare(`
      SELECT risk, count(*) AS count FROM contents
      WHERE id LIKE 'demo-%' GROUP BY risk ORDER BY risk
    `).all()
    expect(risks).toEqual([
      { risk: 'HIGH', count: 26 },
      { risk: 'LOW', count: 30 },
    ])

    const rounds = database.prepare(`
      SELECT rr.round_no, rr.status, cr.title
      FROM review_rounds rr JOIN content_revisions cr ON cr.id = rr.revision_id
      WHERE rr.content_id = 'demo-resubmitted' ORDER BY rr.round_no
    `).all()
    expect(rounds).toEqual([
      { round_no: 1, status: 'REJECTED', title: '用户通知模板（初稿）' },
      { round_no: 2, status: 'APPROVED', title: '用户通知模板（修订版）' },
    ])
  })

  it('keeps pending progress and terminal decisions consistent', () => {
    seedDemoData(database)
    const pending = database.prepare(`
      SELECT rr.status, rr.required_approvals,
        sum(CASE WHEN rd.decision = 'APPROVE' THEN 1 ELSE 0 END) AS approvals
      FROM review_rounds rr LEFT JOIN review_decisions rd ON rd.round_id = rr.id
      WHERE rr.id = 'demo-high-pending-round-1' GROUP BY rr.id
    `).get()
    expect(pending).toEqual({ status: 'OPEN', required_approvals: 2, approvals: 1 })

    const invalid = database.prepare(`
      SELECT count(*) AS count FROM review_decisions rd
      JOIN review_rounds rr ON rr.id = rd.round_id
      JOIN contents c ON c.id = rr.content_id
      WHERE rd.reviewer_id = c.author_id
    `).get() as unknown as { count: number }
    expect(invalid.count).toBe(0)

    const terminalCount = database.prepare(`
      SELECT count(*) AS count FROM review_decisions
      WHERE round_id = 'demo-concurrent-terminal-round-1'
    `).get() as unknown as { count: number }
    expect(terminalCount.count).toBe(1)

    const pendingFor = (reviewerId: string) =>
      (
        database.prepare(`
          SELECT count(*) AS count
          FROM review_rounds rr
          JOIN contents c ON c.id = rr.content_id
          WHERE rr.status = 'OPEN'
            AND c.status = 'IN_REVIEW'
            AND c.author_id <> ?
            AND NOT EXISTS (
              SELECT 1 FROM review_decisions mine
              WHERE mine.round_id = rr.id AND mine.reviewer_id = ?
            )
        `).get(reviewerId, reviewerId) as unknown as { count: number }
      ).count

    expect({
      alice: pendingFor(USER_IDS.alice),
      bob: pendingFor(USER_IDS.bob),
      chen: pendingFor(USER_IDS.chen),
    }).toEqual({ alice: 0, bob: 15, chen: 19 })
  })
})