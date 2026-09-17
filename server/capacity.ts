import type { DatabaseSync } from 'node:sqlite'

export interface CapacityLimits {
  maxUsers: number
  maxContents: number
  maxRoundsPerContent: number
  maxIdempotencyRecords: number
  idempotencyTtlHours: number
  maxDatabaseBytes: number
  databaseReserveBytes: number
}

const mebibyte = 1024 * 1024

export const defaultCapacityLimits: CapacityLimits = {
  maxUsers: 100,
  maxContents: 500,
  maxRoundsPerContent: 20,
  maxIdempotencyRecords: 2_000,
  idempotencyTtlHours: 24,
  maxDatabaseBytes: 128 * mebibyte,
  databaseReserveBytes: 8 * mebibyte,
}

const environmentLimits: Record<keyof CapacityLimits, string> = {
  maxUsers: 'REVIEWFLOW_MAX_USERS',
  maxContents: 'REVIEWFLOW_MAX_CONTENTS',
  maxRoundsPerContent: 'REVIEWFLOW_MAX_ROUNDS_PER_CONTENT',
  maxIdempotencyRecords: 'REVIEWFLOW_MAX_IDEMPOTENCY_RECORDS',
  idempotencyTtlHours: 'REVIEWFLOW_IDEMPOTENCY_TTL_HOURS',
  maxDatabaseBytes: 'REVIEWFLOW_MAX_DATABASE_BYTES',
  databaseReserveBytes: 'REVIEWFLOW_DATABASE_RESERVE_BYTES',
}

export class CapacityLimitError extends Error {
  readonly statusCode = 507
  readonly code = 'CAPACITY_LIMIT_REACHED'

  constructor(message: string) {
    super(message)
  }
}

export function resolveCapacityLimits(
  overrides: Partial<CapacityLimits> = {},
): CapacityLimits {
  const resolved = { ...defaultCapacityLimits }
  for (const key of Object.keys(environmentLimits) as Array<keyof CapacityLimits>) {
    const environmentValue = process.env[environmentLimits[key]]
    const value = overrides[key] ?? (
      environmentValue === undefined ? resolved[key] : Number(environmentValue)
    )
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${environmentLimits[key]} must be a positive integer`)
    }
    resolved[key] = value
  }

  if (resolved.maxDatabaseBytes < 16 * mebibyte) {
    throw new Error('REVIEWFLOW_MAX_DATABASE_BYTES must be at least 16 MiB')
  }
  if (resolved.databaseReserveBytes >= resolved.maxDatabaseBytes / 2) {
    throw new Error('Database reserve must be less than half of the database limit')
  }
  return resolved
}

export function configureDatabaseCapacity(
  database: DatabaseSync,
  limits: CapacityLimits,
): void {
  const pageSize = pragmaNumber(database, 'page_size')
  const currentPageCount = pragmaNumber(database, 'page_count')
  const maxPageCount = Math.floor(limits.maxDatabaseBytes / pageSize)
  if (maxPageCount < currentPageCount) {
    throw new Error(
      `Database already uses ${currentPageCount * pageSize} bytes, which exceeds the configured capacity`,
    )
  }

  database.exec(`
    PRAGMA max_page_count = ${maxPageCount};
    PRAGMA wal_autocheckpoint = 256;
    PRAGMA journal_size_limit = ${Math.min(limits.databaseReserveBytes, 8 * mebibyte)};
  `)
}

export class CapacityGuard {
  constructor(
    private readonly database: DatabaseSync,
    private readonly limits: CapacityLimits,
  ) {}

  removeExpiredIdempotencyRecords(now = Date.now()): void {
    const cutoff = new Date(
      now - this.limits.idempotencyTtlHours * 60 * 60 * 1000,
    ).toISOString()
    this.database
      .prepare('DELETE FROM idempotency_requests WHERE created_at < ?')
      .run(cutoff)
  }

  assertPersistentWriteAllowed(): void {
    this.assertDatabaseHeadroom()
    this.assertCountBelow(
      'idempotency_requests',
      this.limits.maxIdempotencyRecords,
      '幂等请求记录已达到容量上限，请稍后重试',
    )
  }

  assertUserCapacity(): void {
    this.assertCountBelow(
      'users',
      this.limits.maxUsers,
      '演示用户数量已达到容量上限',
    )
  }

  assertContentCapacity(): void {
    this.assertCountBelow(
      'contents',
      this.limits.maxContents,
      '内容数量已达到容量上限',
    )
  }

  assertRoundCapacity(contentId: string): void {
    const row = this.database
      .prepare('SELECT count(*) AS count FROM review_rounds WHERE content_id = ?')
      .get(contentId) as unknown as { count: number }
    if (row.count >= this.limits.maxRoundsPerContent) {
      throw new CapacityLimitError('该内容的审核轮次数已达到容量上限')
    }
  }

  private assertDatabaseHeadroom(): void {
    const pageSize = pragmaNumber(this.database, 'page_size')
    const pageCount = pragmaNumber(this.database, 'page_count')
    const freePages = pragmaNumber(this.database, 'freelist_count')
    const maxPageCount = pragmaNumber(this.database, 'max_page_count')
    const reusableOrUnallocatedPages = maxPageCount - pageCount + freePages
    const reservePages = Math.ceil(this.limits.databaseReserveBytes / pageSize)
    if (reusableOrUnallocatedPages < reservePages) {
      throw new CapacityLimitError('数据库可用空间不足，已暂停写入')
    }
  }

  private assertCountBelow(
    table: 'users' | 'contents' | 'idempotency_requests',
    limit: number,
    message: string,
  ): void {
    const row = this.database
      .prepare(`SELECT count(*) AS count FROM ${table}`)
      .get() as unknown as { count: number }
    if (row.count >= limit) throw new CapacityLimitError(message)
  }
}

function pragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as
    | Record<string, number | bigint>
    | undefined
  const value = row ? Object.values(row)[0] : undefined
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`Unable to read SQLite pragma: ${pragma}`)
  }
  return Number(value)
}