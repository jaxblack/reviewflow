import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { createDatabase, USER_IDS } from './db.js'

interface DetailResponse {
  content: {
    id: string
    title: string
    status: string
    version: number
  }
  history: Array<{
    id: string
    roundNo: number
    status: string
    approvalCount: number
    requiredApprovals: number
    snapshot: { title: string }
    decisions: Array<{ decision: string }>
  }>
}

describe('ReviewFlow core API', () => {
  let app: FastifyInstance
  let database: DatabaseSync

  beforeEach(async () => {
    database = createDatabase(':memory:')
    app = await buildApp({
      database,
      sessionSecret: 'test-session-secret-with-enough-length',
    })
  })

  afterEach(async () => {
    await app.close()
    database.close()
  })

  it('completes a LOW risk review while enforcing roles and self-review', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const bob = await sessionCookie(USER_IDS.bob)
    const diana = await sessionCookie(USER_IDS.diana)
    const draft = await createContent(alice, 'Low risk', 'Body', 'LOW')
    const submitted = await submitContent(alice, draft.content.id, draft.content.version)
    const roundId = submitted.history[0].id

    const selfReview = await decide(alice, roundId, 'APPROVE')
    expect(selfReview.statusCode).toBe(409)
    expect(selfReview.json().error.code).toBe('SELF_REVIEW_FORBIDDEN')

    const adminReview = await decide(diana, roundId, 'APPROVE')
    expect(adminReview.statusCode).toBe(403)

    const emptyReject = await decide(bob, roundId, 'REJECT', '   ')
    expect(emptyReject.statusCode).toBe(422)

    const approved = await decide(bob, roundId, 'APPROVE', 'Looks good')
    expect(approved.statusCode).toBe(200)
    expect((approved.json() as DetailResponse).content.status).toBe('APPROVED')

    const editAfterApproval = await app.inject({
      method: 'PATCH',
      url: `/api/contents/${draft.content.id}`,
      headers: headers(alice),
      payload: {
        title: 'Changed',
        body: 'Body',
        risk: 'LOW',
        expectedVersion: (approved.json() as DetailResponse).content.version,
      },
    })
    expect(editAfterApproval.statusCode).toBe(409)
  })

  it('keeps snapshots and resets votes when a HIGH risk item is resubmitted', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const bob = await sessionCookie(USER_IDS.bob)
    const chen = await sessionCookie(USER_IDS.chen)
    const draft = await createContent(alice, 'Original title', 'Original body', 'HIGH')
    const firstSubmit = await submitContent(
      alice,
      draft.content.id,
      draft.content.version,
    )
    const firstRoundId = firstSubmit.history[0].id

    const bobApproval = await decide(bob, firstRoundId, 'APPROVE', 'ok')
    const afterBob = bobApproval.json() as DetailResponse
    expect(afterBob.content.status).toBe('IN_REVIEW')
    expect(afterBob.history[0].approvalCount).toBe(1)

    const rejected = await decide(chen, firstRoundId, 'REJECT', 'Needs changes')
    expect((rejected.json() as DetailResponse).content.status).toBe('REJECTED')

    const rejectedDetail = await getDetail(alice, draft.content.id)
    const editedResponse = await app.inject({
      method: 'PATCH',
      url: `/api/contents/${draft.content.id}`,
      headers: headers(alice),
      payload: {
        title: 'Revised title',
        body: 'Revised body',
        risk: 'HIGH',
        expectedVersion: rejectedDetail.content.version,
      },
    })
    expect(editedResponse.statusCode).toBe(200)
    const edited = editedResponse.json() as DetailResponse
    const secondSubmit = await submitContent(
      alice,
      draft.content.id,
      edited.content.version,
    )
    const secondRoundId = secondSubmit.history[0].id

    const secondBob = await decide(bob, secondRoundId, 'APPROVE')
    const oneOfTwo = secondBob.json() as DetailResponse
    expect(oneOfTwo.content.status).toBe('IN_REVIEW')
    expect(oneOfTwo.history[0].approvalCount).toBe(1)

    const final = await decide(chen, secondRoundId, 'APPROVE')
    const detail = final.json() as DetailResponse
    expect(detail.content.status).toBe('APPROVED')
    expect(detail.history).toHaveLength(2)
    expect(detail.history[0].snapshot.title).toBe('Revised title')
    expect(detail.history[1].snapshot.title).toBe('Original title')
    expect(detail.history[1].status).toBe('REJECTED')
  })

  it('returns the original result for retries and rejects key reuse', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const key = randomUUID()
    const payload = { title: 'Idempotent', body: 'Body', risk: 'LOW' }
    const first = await app.inject({
      method: 'POST',
      url: '/api/contents',
      headers: headers(alice, key),
      payload,
    })
    const retry = await app.inject({
      method: 'POST',
      url: '/api/contents',
      headers: headers(alice, key),
      payload,
    })
    expect(retry.statusCode).toBe(201)
    expect(retry.headers['idempotency-replayed']).toBe('true')
    expect(retry.json().content.id).toBe(first.json().content.id)

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/contents',
      headers: headers(alice, key),
      payload: { ...payload, title: 'Different' },
    })
    expect(conflict.statusCode).toBe(409)

    const count = database
      .prepare('SELECT count(*) AS count FROM contents')
      .get() as unknown as { count: number }
    expect(count.count).toBe(1)
  })

  it('allows only one terminal result when approval and rejection race', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const bob = await sessionCookie(USER_IDS.bob)
    const chen = await sessionCookie(USER_IDS.chen)
    const draft = await createContent(alice, 'Race', 'Body', 'LOW')
    const submitted = await submitContent(alice, draft.content.id, draft.content.version)
    const roundId = submitted.history[0].id

    const [approve, reject] = await Promise.all([
      decide(bob, roundId, 'APPROVE'),
      decide(chen, roundId, 'REJECT', 'No'),
    ])
    expect([approve.statusCode, reject.statusCode].sort()).toEqual([200, 409])

    const detail = await getDetail(alice, draft.content.id)
    expect(['APPROVED', 'REJECTED']).toContain(detail.content.status)
    expect(detail.history[0].decisions).toHaveLength(1)
    expect(detail.history[0].status).toBe(detail.content.status)
  })

  async function sessionCookie(userId: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/switch',
      payload: { userId },
    })
    expect(response.statusCode).toBe(200)
    const value = response.headers['set-cookie']
    const cookie = Array.isArray(value) ? value[0] : value
    return String(cookie).split(';')[0]
  }

  function headers(cookie: string, key = randomUUID()): Record<string, string> {
    return { cookie, 'idempotency-key': key }
  }

  async function createContent(
    cookie: string,
    title: string,
    body: string,
    risk: 'LOW' | 'HIGH',
  ): Promise<DetailResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/contents',
      headers: headers(cookie),
      payload: { title, body, risk },
    })
    expect(response.statusCode).toBe(201)
    return response.json() as DetailResponse
  }

  async function submitContent(
    cookie: string,
    contentId: string,
    expectedVersion: number,
  ): Promise<DetailResponse> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/contents/${contentId}/submit`,
      headers: headers(cookie),
      payload: { expectedVersion },
    })
    expect(response.statusCode).toBe(201)
    return response.json() as DetailResponse
  }

  function decide(
    cookie: string,
    roundId: string,
    decision: 'APPROVE' | 'REJECT',
    comment?: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/review-rounds/${roundId}/decisions`,
      headers: headers(cookie),
      payload: { decision, ...(comment === undefined ? {} : { comment }) },
    })
  }

  async function getDetail(cookie: string, contentId: string): Promise<DetailResponse> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/contents/${contentId}`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    return response.json() as DetailResponse
  }
})