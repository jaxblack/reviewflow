export interface CapacityLimits {
  maxUsers: number
  maxContents: number
  maxRoundsPerContent: number
  maxIdempotencyRecords: number
  idempotencyTtlHours: number
}

export const defaultCapacityLimits: CapacityLimits = {
  maxUsers: 100,
  maxContents: 500,
  maxRoundsPerContent: 20,
  maxIdempotencyRecords: 2_000,
  idempotencyTtlHours: 24,
}

const environmentLimits: Record<keyof CapacityLimits, string> = {
  maxUsers: 'REVIEWFLOW_MAX_USERS',
  maxContents: 'REVIEWFLOW_MAX_CONTENTS',
  maxRoundsPerContent: 'REVIEWFLOW_MAX_ROUNDS_PER_CONTENT',
  maxIdempotencyRecords: 'REVIEWFLOW_MAX_IDEMPOTENCY_RECORDS',
  idempotencyTtlHours: 'REVIEWFLOW_IDEMPOTENCY_TTL_HOURS',
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
  return resolved
}