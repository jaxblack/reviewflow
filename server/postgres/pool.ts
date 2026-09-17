import pg from 'pg'

const { Pool, types } = pg

types.setTypeParser(20, (value) => Number(value))
types.setTypeParser(1184, (value) => value)

export function requireDatabaseUrl(
  databaseUrl = process.env.DATABASE_URL,
): string {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }
  return databaseUrl
}

export function createPostgresPool(databaseUrl = requireDatabaseUrl()): pg.Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'reviewflow',
  })
}