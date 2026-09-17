import pg, { type Pool } from 'pg'
import { migratePostgres } from '../postgres/migrate.js'

const { Pool: PostgresPool } = pg

export interface PostgresTestDatabase {
  pool: Pool
  databaseUrl: string
  schema: string
  reset(): Promise<void>
  close(): Promise<void>
}

export function hasPostgresTestDatabase(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL)
}

export async function createPostgresTestDatabase(
  suiteName: string,
): Promise<PostgresTestDatabase> {
  const databaseUrl = process.env.TEST_DATABASE_URL
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required')
  const schema = `test_${suiteName.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}_${process.pid}`
  const adminPool = new PostgresPool({ connectionString: databaseUrl })
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await adminPool.query(`CREATE SCHEMA ${schema}`)
  const pool = new PostgresPool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 20,
  })
  await migratePostgres(pool)

  return {
    pool,
    databaseUrl,
    schema,
    reset: () => resetPostgresTestData(pool),
    close: async () => {
      await pool.end()
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await adminPool.end()
    },
  }
}

async function resetPostgresTestData(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      idempotency_requests,
      review_decisions,
      review_rounds,
      content_revisions,
      contents,
      user_roles,
      users
    CASCADE;

    INSERT INTO users (id, display_name) VALUES
      ('user-alice', 'Alice'),
      ('user-bob', 'Bob'),
      ('user-chen', 'Chen'),
      ('user-diana', 'Diana');

    INSERT INTO user_roles (user_id, role) VALUES
      ('user-alice', 'SUBMITTER'),
      ('user-alice', 'REVIEWER'),
      ('user-bob', 'REVIEWER'),
      ('user-chen', 'REVIEWER'),
      ('user-diana', 'ADMIN');

    UPDATE capacity_counters SET used = CASE resource
      WHEN 'users' THEN 4
      ELSE 0
    END;
  `)
}