import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { USER_IDS } from './db.js'

interface TestServer {
  baseUrl: string
  process: ChildProcessWithoutNullStreams
  logs: string[]
}

interface ApiResult {
  status: number
  body: Record<string, any>
  replayed: string | null
}

const projectRoot = resolve(import.meta.dirname, '..')
const workerPath = resolve(import.meta.dirname, 'concurrency-worker.mjs')
const sessionSecret = 'multi-process-concurrency-secret-at-least-32-bytes'

describe('SQLite multi-process concurrency', () => {
  let temporaryDirectory: string
  let barrierDirectory: string
  let databasePath: string
  let serverA: TestServer
  let serverB: TestServer

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'reviewflow-concurrency-'))
    barrierDirectory = join(temporaryDirectory, 'barriers')
    databasePath = join(temporaryDirectory, 'reviewflow.db')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(barrierDirectory))
    serverA = await startServer(databasePath, barrierDirectory)
    serverB = await startServer(databasePath, barrierDirectory)
  }, 20_000)

  afterEach(async () => {
    await Promise.all([stopServer(serverA), stopServer(serverB)])
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('serializes LOW approval and rejection across two app processes', async () => {
    const alice = await switchUser(serverA, USER_IDS.alice)
    const bob = await switchUser(serverA, USER_IDS.bob)
    const chen = await switchUser(serverB, USER_IDS.chen)
    const draft = await mutate(serverA, '/api/contents', {
      cookie: alice,
      body: { title: 'Multi-process terminal race', body: 'Body', risk: 'LOW' },
    })
    const submitted = await mutate(
      serverA,
      `/api/contents/${draft.body.content.id}/submit`,
      {
        cookie: alice,
        body: { expectedVersion: draft.body.content.version },
      },
    )
    const roundId = submitted.body.history[0].id as string

    const [approve, reject] = await raceMutations(
      {
        server: serverA,
        path: `/api/review-rounds/${roundId}/decisions`,
        cookie: bob,
        body: { decision: 'APPROVE' },
      },
      {
        server: serverB,
        path: `/api/review-rounds/${roundId}/decisions`,
        cookie: chen,
        body: { decision: 'REJECT', comment: 'Concurrent rejection' },
      },
    )

    expect([approve.status, reject.status].sort()).toEqual([200, 409])
    const facts = readFacts(databasePath, roundId)
    expect(facts.decision_count).toBe(1)
    expect(facts.round_status).toBe(facts.content_status)
    expect(['APPROVED', 'REJECTED']).toContain(facts.round_status)
  }, 20_000)

  async function raceMutations(
    left: MutationRequest,
    right: MutationRequest,
  ): Promise<[ApiResult, ApiResult]> {
    const barrierId = crypto.randomUUID()
    const leftRequest = mutate(left.server, left.path, {
      cookie: left.cookie,
      body: left.body,
      barrierId,
    })
    const rightRequest = mutate(right.server, right.path, {
      cookie: right.cookie,
      body: right.body,
      barrierId,
    })
    await waitForArrivals(barrierId, 2)
    await writeFile(join(barrierDirectory, `${barrierId}.release`), '', 'utf8')
    return Promise.all([leftRequest, rightRequest])
  }

  async function waitForArrivals(barrierId: string, expected: number): Promise<void> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const entries = await readdir(barrierDirectory)
      const arrived = entries.filter(
        (entry) => entry.startsWith(`${barrierId}.`) && entry.endsWith('.arrived'),
      )
      if (arrived.length >= expected) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`Requests did not reach barrier ${barrierId}`)
  }
})

interface MutationRequest {
  server: TestServer
  path: string
  cookie: string
  body: Record<string, unknown>
}

async function startServer(
  databasePath: string,
  barrierDirectory: string,
): Promise<TestServer> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', workerPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        REVIEWFLOW_TEST_DATABASE: databasePath,
        REVIEWFLOW_TEST_BARRIER_DIRECTORY: barrierDirectory,
        REVIEWFLOW_TEST_SESSION_SECRET: sessionSecret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const logs: string[] = []
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const timer = setTimeout(() => {
      rejectPort(new Error(`Worker startup timed out:\n${logs.join('')}`))
    }, 15_000)
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      const match = output.match(/READY (\d+)/)
      if (!match) return
      clearTimeout(timer)
      resolvePort(Number(match[1]))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectPort(new Error(`Worker exited with ${code}:\n${logs.join('')}${output}`))
    })
  })
  return { baseUrl: `http://127.0.0.1:${port}`, process: child, logs }
}

async function stopServer(server: TestServer | undefined): Promise<void> {
  if (!server || server.process.exitCode !== null) return
  server.process.kill('SIGTERM')
  const exited = once(server.process, 'exit')
  const timeout = new Promise<'timeout'>((resolveTimeout) => {
    setTimeout(() => resolveTimeout('timeout'), 3_000)
  })
  if ((await Promise.race([exited, timeout])) === 'timeout') {
    server.process.kill('SIGKILL')
    await once(server.process, 'exit')
  }
}

async function switchUser(server: TestServer, userId: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/session/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  })
  expect(response.status).toBe(200)
  return String(response.headers.get('set-cookie')).split(';')[0]
}

async function mutate(
  server: TestServer,
  path: string,
  options: {
    cookie?: string
    body: Record<string, unknown>
    barrierId?: string
    idempotencyKey?: string
    method?: 'POST' | 'PATCH'
  },
): Promise<ApiResult> {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': options.idempotencyKey ?? crypto.randomUUID(),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.barrierId
        ? { 'x-reviewflow-test-barrier': options.barrierId }
        : {}),
    },
    body: JSON.stringify(options.body),
  })
  return {
    status: response.status,
    body: await response.json() as Record<string, any>,
    replayed: response.headers.get('idempotency-replayed'),
  }
}

function readFacts(databasePath: string, roundId: string): {
  decision_count: number
  round_status: string
  content_status: string
} {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database.prepare(`
      SELECT rr.status AS round_status, c.status AS content_status,
        (SELECT count(*) FROM review_decisions rd WHERE rd.round_id = rr.id)
          AS decision_count
      FROM review_rounds rr
      JOIN contents c ON c.id = rr.content_id
      WHERE rr.id = ?
    `).get(roundId) as unknown as {
      decision_count: number
      round_status: string
      content_status: string
    }
  } finally {
    database.close()
  }
}