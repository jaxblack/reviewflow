import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { USER_IDS } from './postgres/store.js'
import {
  createPostgresTestDatabase,
  hasPostgresTestDatabase,
  type PostgresTestDatabase,
} from './test/postgres.js'

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

interface MutationRequest {
  server: TestServer
  path: string
  cookie: string
  body: Record<string, unknown>
  idempotencyKey?: string
}

interface RoundFacts {
  content_id: string
  decision_count: number
  approval_count: number
  round_status: string
  content_status: string
}

const projectRoot = resolve(import.meta.dirname, '..')
const workerPath = resolve(import.meta.dirname, 'concurrency-worker.mjs')
const sessionSecret = 'multi-process-concurrency-secret-at-least-32-bytes'
const describePostgres = hasPostgresTestDatabase() ? describe : describe.skip

describePostgres('PostgreSQL multi-process concurrency', () => {
  let temporaryDirectory: string
  let barrierDirectory: string
  let testDatabase: PostgresTestDatabase
  let serverA: TestServer
  let serverB: TestServer

  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase('concurrency')
  }, 20_000)

  beforeEach(async () => {
    await testDatabase.reset()
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'reviewflow-concurrency-'))
    barrierDirectory = join(temporaryDirectory, 'barriers')
    await mkdir(barrierDirectory)
    serverA = await startServer(testDatabase, barrierDirectory)
    serverB = await startServer(testDatabase, barrierDirectory)
  }, 20_000)

  afterEach(async () => {
    await Promise.all([stopServer(serverA), stopServer(serverB)])
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  afterAll(async () => testDatabase.close())

  it('serializes LOW approval and rejection across two app processes', async () => {
    const { bob, chen, roundId } = await createSubmitted('LOW')
    const [approve, reject] = await raceMutations(
      decisionRequest(serverA, bob, roundId, 'APPROVE'),
      decisionRequest(serverB, chen, roundId, 'REJECT', 'Concurrent rejection'),
    )

    expect([approve.status, reject.status].sort()).toEqual([200, 409])
    const facts = await readFacts(roundId)
    expect(facts.decision_count).toBe(1)
    expect(facts.round_status).toBe(facts.content_status)
    expect(['APPROVED', 'REJECTED']).toContain(facts.round_status)
  }, 20_000)

  it('keeps HIGH first approval and rejection semantically consistent', async () => {
    const { bob, chen, roundId } = await createSubmitted('HIGH')
    const [approve, reject] = await raceMutations(
      decisionRequest(serverA, bob, roundId, 'APPROVE'),
      decisionRequest(serverB, chen, roundId, 'REJECT', 'Reject first round'),
    )

    expect([200, 409]).toContain(approve.status)
    expect(reject.status).toBe(200)
    const facts = await readFacts(roundId)
    expect(facts.round_status).toBe('REJECTED')
    expect(facts.content_status).toBe('REJECTED')
    expect([1, 2]).toContain(facts.decision_count)
  }, 20_000)

  it('allows one terminal result for HIGH second approval versus rejection', async () => {
    const { bob, chen, roundId } = await createSubmitted('HIGH')
    await addReviewer('reviewer-extra', 'Extra Reviewer')
    const extra = await switchUser(serverB, 'reviewer-extra')
    const first = await mutate(
      decisionRequest(serverA, bob, roundId, 'APPROVE').server,
      `/api/review-rounds/${roundId}/decisions`,
      { cookie: bob, body: { decision: 'APPROVE' } },
    )
    expect(first.status).toBe(200)

    const [approve, reject] = await raceMutations(
      decisionRequest(serverA, chen, roundId, 'APPROVE'),
      decisionRequest(serverB, extra, roundId, 'REJECT', 'Terminal rejection'),
    )

    expect([approve.status, reject.status].sort()).toEqual([200, 409])
    const facts = await readFacts(roundId)
    expect(facts.decision_count).toBe(2)
    expect(facts.round_status).toBe(facts.content_status)
    expect(['APPROVED', 'REJECTED']).toContain(facts.round_status)
  }, 20_000)

  it('accepts two different HIGH approvals and closes at two votes', async () => {
    const { bob, chen, roundId } = await createSubmitted('HIGH')
    const [first, second] = await raceMutations(
      decisionRequest(serverA, bob, roundId, 'APPROVE'),
      decisionRequest(serverB, chen, roundId, 'APPROVE'),
    )

    expect([first.status, second.status]).toEqual([200, 200])
    expect(await readFacts(roundId)).toMatchObject({
      decision_count: 2,
      approval_count: 2,
      round_status: 'APPROVED',
      content_status: 'APPROVED',
    })
  }, 20_000)

  it('stores one concurrent identical decision from the same reviewer', async () => {
    const { bob, roundId } = await createSubmitted('HIGH')
    const left = decisionRequest(serverA, bob, roundId, 'APPROVE', 'same')
    const right = decisionRequest(serverB, bob, roundId, 'APPROVE', 'same')
    const [first, second] = await raceMutations(left, right)

    expect([first.status, second.status]).toEqual([200, 200])
    expect(await readFacts(roundId)).toMatchObject({
      decision_count: 1,
      approval_count: 1,
      round_status: 'OPEN',
      content_status: 'IN_REVIEW',
    })
  }, 20_000)

  it('rejects one conflicting decision from the same reviewer', async () => {
    const { bob, roundId } = await createSubmitted('HIGH')
    const [approve, reject] = await raceMutations(
      decisionRequest(serverA, bob, roundId, 'APPROVE'),
      decisionRequest(serverB, bob, roundId, 'REJECT', 'Conflicting choice'),
    )

    expect([approve.status, reject.status].sort()).toEqual([200, 409])
    const facts = await readFacts(roundId)
    expect(facts.decision_count).toBe(1)
    expect([
      ['OPEN', 'IN_REVIEW'],
      ['REJECTED', 'REJECTED'],
    ]).toContainEqual([facts.round_status, facts.content_status])
  }, 20_000)

  it('creates one round for concurrent duplicate submissions', async () => {
    const alice = await switchUser(serverA, USER_IDS.alice)
    const draft = await mutate(serverA, '/api/contents', {
      cookie: alice,
      body: { title: 'Concurrent submission', body: 'Body', risk: 'LOW' },
    })
    const request = {
      path: `/api/contents/${draft.body.content.id}/submit`,
      cookie: alice,
      body: { expectedVersion: draft.body.content.version },
    }
    const [first, second] = await raceMutations(
      { server: serverA, ...request },
      { server: serverB, ...request },
    )

    expect([first.status, second.status].sort()).toEqual([201, 409])
    const counts = await testDatabase.pool.query(`
      SELECT
        (SELECT count(*)::int FROM content_revisions WHERE content_id = $1) AS revisions,
        (SELECT count(*)::int FROM review_rounds WHERE content_id = $1) AS rounds,
        (SELECT count(*)::int FROM review_rounds
          WHERE content_id = $1 AND status = 'OPEN') AS open_rounds
    `, [draft.body.content.id])
    expect(counts.rows[0]).toEqual({ revisions: 1, rounds: 1, open_rounds: 1 })
  }, 20_000)

  it('replays one idempotency key across two app instances', async () => {
    const aliceA = await switchUser(serverA, USER_IDS.alice)
    const aliceB = await switchUser(serverB, USER_IDS.alice)
    const idempotencyKey = crypto.randomUUID()
    const body = { title: 'Cross-instance idempotency', body: 'Body', risk: 'LOW' }
    const [first, second] = await raceMutations(
      { server: serverA, path: '/api/contents', cookie: aliceA, body, idempotencyKey },
      { server: serverB, path: '/api/contents', cookie: aliceB, body, idempotencyKey },
    )

    expect([first.status, second.status]).toEqual([201, 201])
    expect([first.replayed, second.replayed].sort()).toEqual(['false', 'true'])
    expect(first.body.content.id).toBe(second.body.content.id)
    const count = await testDatabase.pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM contents WHERE title = $1
    `, [body.title])
    expect(count.rows[0].count).toBe(1)
  }, 20_000)

  it('allows exactly two of eight reviewers to close a HIGH round', async () => {
    const { roundId } = await createSubmitted('HIGH')
    const reviewerIds = Array.from({ length: 8 }, (_, index) => `reviewer-${index + 1}`)
    for (const [index, reviewerId] of reviewerIds.entries()) {
      await addReviewer(reviewerId, `Reviewer ${index + 1}`)
    }
    const cookies = await Promise.all(
      reviewerIds.map((id, index) => switchUser(index % 2 ? serverA : serverB, id)),
    )
    const results = await raceMany(cookies.map((cookie, index) =>
      decisionRequest(
        index % 2 ? serverA : serverB,
        cookie,
        roundId,
        'APPROVE',
      ),
    ))

    expect(results.filter((result) => result.status === 200)).toHaveLength(2)
    expect(results.filter((result) => result.status === 409)).toHaveLength(6)
    expect(await readFacts(roundId)).toMatchObject({
      decision_count: 2,
      approval_count: 2,
      round_status: 'APPROVED',
      content_status: 'APPROVED',
    })
  }, 25_000)

  async function createSubmitted(risk: 'LOW' | 'HIGH') {
    const alice = await switchUser(serverA, USER_IDS.alice)
    const bob = await switchUser(serverA, USER_IDS.bob)
    const chen = await switchUser(serverB, USER_IDS.chen)
    const draft = await mutate(serverA, '/api/contents', {
      cookie: alice,
      body: { title: `${risk} concurrent review`, body: 'Body', risk },
    })
    const submitted = await mutate(
      serverA,
      `/api/contents/${draft.body.content.id}/submit`,
      { cookie: alice, body: { expectedVersion: draft.body.content.version } },
    )
    return {
      alice,
      bob,
      chen,
      contentId: draft.body.content.id as string,
      roundId: submitted.body.history[0].id as string,
    }
  }

  async function addReviewer(id: string, name: string): Promise<void> {
    await testDatabase.pool.query(
      'INSERT INTO users (id, display_name) VALUES ($1, $2)',
      [id, name],
    )
    await testDatabase.pool.query(
      "INSERT INTO user_roles (user_id, role) VALUES ($1, 'REVIEWER')",
      [id],
    )
  }

  async function readFacts(roundId: string): Promise<RoundFacts> {
    const result = await testDatabase.pool.query<RoundFacts>(`
      SELECT rr.content_id, rr.status AS round_status, c.status AS content_status,
        (SELECT count(*)::int FROM review_decisions rd WHERE rd.round_id = rr.id)
          AS decision_count,
        (SELECT count(*)::int FROM review_decisions rd
          WHERE rd.round_id = rr.id AND rd.decision = 'APPROVE') AS approval_count
      FROM review_rounds rr
      JOIN contents c ON c.id = rr.content_id
      WHERE rr.id = $1
    `, [roundId])
    return result.rows[0]
  }

  async function raceMutations(
    left: MutationRequest,
    right: MutationRequest,
  ): Promise<[ApiResult, ApiResult]> {
    const results = await raceMany([left, right])
    return [results[0], results[1]]
  }

  async function raceMany(requests: MutationRequest[]): Promise<ApiResult[]> {
    const barrierId = crypto.randomUUID()
    const pending = requests.map((request) => mutate(request.server, request.path, {
      cookie: request.cookie,
      body: request.body,
      barrierId,
      idempotencyKey: request.idempotencyKey,
    }))
    await waitForArrivals(barrierId, requests.length)
    await writeFile(join(barrierDirectory, `${barrierId}.release`), '', 'utf8')
    return Promise.all(pending)
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

function decisionRequest(
  server: TestServer,
  cookie: string,
  roundId: string,
  decision: 'APPROVE' | 'REJECT',
  comment?: string,
): MutationRequest {
  return {
    server,
    path: `/api/review-rounds/${roundId}/decisions`,
    cookie,
    body: { decision, ...(comment === undefined ? {} : { comment }) },
  }
}

async function startServer(
  testDatabase: PostgresTestDatabase,
  barrierDirectory: string,
): Promise<TestServer> {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TEST_DATABASE_URL: testDatabase.databaseUrl,
      REVIEWFLOW_TEST_SCHEMA: testDatabase.schema,
      REVIEWFLOW_TEST_BARRIER_DIRECTORY: barrierDirectory,
      REVIEWFLOW_TEST_SESSION_SECRET: sessionSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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