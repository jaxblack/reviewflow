import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { buildApp } from './app.ts'

const databaseUrl = process.env.TEST_DATABASE_URL
const databaseSchema = process.env.REVIEWFLOW_TEST_SCHEMA
const barrierDirectory = process.env.REVIEWFLOW_TEST_BARRIER_DIRECTORY
const sessionSecret = process.env.REVIEWFLOW_TEST_SESSION_SECRET

if (!databaseUrl || !databaseSchema || !barrierDirectory || !sessionSecret) {
  throw new Error('Missing concurrency worker configuration')
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${databaseSchema}`,
  max: 10,
})

const app = await buildApp({
  pool,
  migrate: false,
  logger: false,
  sessionSecret,
  writeRateLimitMax: 100_000,
  beforeWriteRequest: async (request) => {
    const barrierId = request.headers['x-reviewflow-test-barrier']
    if (typeof barrierId !== 'string' || !/^[a-f0-9-]{36}$/.test(barrierId)) return

    await writeFile(
      join(barrierDirectory, `${barrierId}.${process.pid}.${crypto.randomUUID()}.arrived`),
      '',
      'utf8',
    )
    const releasePath = join(barrierDirectory, `${barrierId}.release`)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        await access(releasePath)
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    throw new Error(`Concurrency barrier timed out: ${barrierId}`)
  },
})

await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing worker address')
process.stdout.write(`READY ${address.port}\n`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close()
    await pool.end()
    process.exit(0)
  })
}