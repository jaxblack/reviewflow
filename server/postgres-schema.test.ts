import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migratePostgres } from './postgres/migrate.js'
import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from './test/postgres.js'

const describePostgres = hasPostgresTestDatabase() ? describe : describe.skip

describePostgres('PostgreSQL relational schema', () => {
  let database: Pool
  let testDatabase: PostgresTestDatabase

  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase('schema')
    database = testDatabase.pool
  }, 20_000)

  beforeEach(async () => testDatabase.reset())
  afterAll(async () => testDatabase.close())

  it('applies migrations idempotently and seeds users and roles once', async () => {
    await migratePostgres(database)
    await migratePostgres(database)
    const facts = await database.query(`
      SELECT
        (SELECT count(*)::int FROM schema_migrations) AS migrations,
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM user_roles) AS roles
    `)
    expect(facts.rows[0]).toEqual({ migrations: 1, users: 4, roles: 5 })
  })

  it('allows only one open review round per content', async () => {
    await insertContent('content-one')
    await insertRevision('revision-one', 'content-one', 1)
    await insertRound('round-one', 'content-one', 'revision-one', 1)
    await insertRevision('revision-two', 'content-one', 2)

    await expect(
      insertRound('round-two', 'content-one', 'revision-two', 2),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'review_rounds_one_open_per_content',
    })
    const open = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM review_rounds WHERE status = 'OPEN'
    `)
    expect(open.rows[0].count).toBe(1)
  })

  it('prevents a round from referencing another content revision', async () => {
    await insertContent('content-one')
    await insertContent('content-two')
    await insertRevision('revision-one', 'content-one', 1)

    await expect(
      insertRound('round-invalid', 'content-two', 'revision-one', 1),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'review_rounds_revision_id_content_id_fkey',
    })
  })

  it('enforces rejection reasons and one decision per reviewer', async () => {
    await insertContent('content-one')
    await insertRevision('revision-one', 'content-one', 1)
    await insertRound('round-one', 'content-one', 'revision-one', 1)

    await expect(database.query(`
      INSERT INTO review_decisions (
        id, round_id, reviewer_id, reviewer_name_snapshot, decision, comment
      ) VALUES ('decision-invalid', 'round-one', 'user-bob', 'Bob', 'REJECT', ' ')
    `)).rejects.toMatchObject({ code: '23514' })

    await database.query(`
      INSERT INTO review_decisions (
        id, round_id, reviewer_id, reviewer_name_snapshot, decision
      ) VALUES ('decision-one', 'round-one', 'user-bob', 'Bob', 'APPROVE')
    `)
    await expect(database.query(`
      INSERT INTO review_decisions (
        id, round_id, reviewer_id, reviewer_name_snapshot, decision, comment
      ) VALUES ('decision-two', 'round-one', 'user-bob', 'Bob', 'REJECT', 'No')
    `)).rejects.toMatchObject({
      code: '23505',
      constraint: 'review_decisions_round_id_reviewer_id_key',
    })
  })

  async function insertContent(id: string): Promise<void> {
    await database.query(`
      INSERT INTO contents (
        id, author_id, title, body, risk, status, version
      ) VALUES ($1, 'user-alice', 'Title', 'Body', 'LOW', 'IN_REVIEW', 2)
    `, [id])
  }

  async function insertRevision(
    id: string,
    contentId: string,
    revisionNo: number,
  ): Promise<void> {
    await database.query(`
      INSERT INTO content_revisions (
        id, content_id, revision_no, title, body, risk,
        author_id, author_name_snapshot
      ) VALUES ($1, $2, $3, 'Title', 'Body', 'LOW', 'user-alice', 'Alice')
    `, [id, contentId, revisionNo])
  }

  async function insertRound(
    id: string,
    contentId: string,
    revisionId: string,
    roundNo: number,
  ): Promise<void> {
    await database.query(`
      INSERT INTO review_rounds (
        id, content_id, revision_id, round_no, required_approvals, status
      ) VALUES ($1, $2, $3, $4, 1, 'OPEN')
    `, [id, contentId, revisionId, roundNo])
  }
})