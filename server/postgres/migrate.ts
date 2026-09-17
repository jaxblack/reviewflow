import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { createPostgresPool } from './pool.js'

const migrationsRoot = resolve(process.cwd(), 'db/migrations')
const migrationLockId = 7_409_221_001

export async function migratePostgres(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockId])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version varchar(255) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const files = (await readdir(migrationsRoot))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
      .sort()

    for (const file of files) {
      await applyMigration(client, file)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId])
      .catch(() => undefined)
    client.release()
  }
}

async function applyMigration(client: PoolClient, file: string): Promise<void> {
  const applied = await client.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [file],
  )
  if (applied.rowCount) return

  const sql = await readFile(resolve(migrationsRoot, file), 'utf8')
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1)',
      [file],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPostgresPool()
  try {
    await migratePostgres(pool)
    console.log('PostgreSQL migrations are current.')
  } finally {
    await pool.end()
  }
}