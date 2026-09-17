if (process.env.CI && !process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required in CI; PostgreSQL tests must not be skipped.')
  process.exit(1)
}