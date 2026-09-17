import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { defaultCapacityLimits } from './capacity.js'
import { createDatabase, USER_IDS } from './db.js'

interface DetailResponse {
  content: {
    id: string
    title: string
    status: string
    version: number
    author?: { name: string }
  }
  history: Array<{
    id: string
    roundNo: number
    status: string
    approvalCount: number
    requiredApprovals: number
    snapshot: { title: string; authorName?: string }
    decisions: Array<{ decision: string; reviewer?: { name: string } }>
  }>
}

interface WorkspaceResponse {
  items: Array<{
    id: string
    title: string
    risk: string
    roundCount: number
    queues: Array<'MINE' | 'PENDING_REVIEW' | 'REVIEWED' | 'ADMIN'>
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

  it('returns one identity-scoped workspace with deduplicated flow queues', async () => {
    database
      .prepare(`
        INSERT INTO user_roles (user_id, role) VALUES (?, 'SUBMITTER')
      `)
      .run(USER_IDS.bob)
    const alice = await sessionCookie(USER_IDS.alice)
    const bob = await sessionCookie(USER_IDS.bob)
    const mine = await createContent(alice, 'Alice draft', 'Body', 'LOW')
    const bobDraft = await createContent(bob, 'Bob request', 'Body', 'LOW')
    const bobSubmitted = await submitContent(
      bob,
      bobDraft.content.id,
      bobDraft.content.version,
    )

    const before = await getWorkspace(alice)
    expect(before.items.find((item) => item.id === mine.content.id)).toMatchObject({
      roundCount: 0,
      queues: ['MINE'],
    })
    expect(before.items.find((item) => item.id === bobDraft.content.id)).toMatchObject({
      roundCount: 1,
      queues: ['PENDING_REVIEW'],
    })
    expect(new Set(before.items.map((item) => item.id)).size).toBe(before.items.length)

    await decide(alice, bobSubmitted.history[0].id, 'APPROVE', 'Reviewed')
    const after = await getWorkspace(alice)
    const reviewed = after.items.find((item) => item.id === bobDraft.content.id)
    expect(reviewed?.queues).toContain('REVIEWED')
    expect(reviewed?.queues).not.toContain('PENDING_REVIEW')

    const diana = await sessionCookie(USER_IDS.diana)
    const adminWorkspace = await getWorkspace(diana)
    expect(adminWorkspace.items).toHaveLength(2)
    expect(adminWorkspace.items.every((item) => item.queues.includes('ADMIN'))).toBe(true)
  })

  it('does not expose rejected working-copy changes in a reviewer workspace', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const bob = await sessionCookie(USER_IDS.bob)
    const diana = await sessionCookie(USER_IDS.diana)
    const draft = await createContent(alice, 'Submitted title', 'Submitted body', 'LOW')
    const submitted = await submitContent(alice, draft.content.id, draft.content.version)
    await decide(bob, submitted.history[0].id, 'REJECT', 'Please revise')
    const rejected = await getDetail(alice, draft.content.id)
    const editedResponse = await app.inject({
      method: 'PATCH',
      url: `/api/contents/${draft.content.id}`,
      headers: headers(alice),
      payload: {
        title: 'Private working title',
        body: 'Private working body',
        risk: 'HIGH',
        expectedVersion: rejected.content.version,
      },
    })
    expect(editedResponse.statusCode).toBe(200)

    const reviewerItem = (await getWorkspace(bob)).items.find(
      (item) => item.id === draft.content.id,
    )
    expect(reviewerItem).toMatchObject({
      title: 'Submitted title',
      risk: 'LOW',
      queues: ['REVIEWED'],
    })

    const adminItem = (await getWorkspace(diana)).items.find(
      (item) => item.id === draft.content.id,
    )
    expect(adminItem).toMatchObject({
      title: 'Private working title',
      risk: 'HIGH',
      queues: ['ADMIN'],
    })
  })

  it('allows only admins to create users and manage additive roles', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const diana = await sessionCookie(USER_IDS.diana)

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: alice },
    })
    expect(forbidden.statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: headers(diana),
      payload: { name: 'Eva', roles: ['SUBMITTER'] },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      name: 'Eva',
      roles: ['SUBMITTER'],
      contentCount: 0,
      decisionCount: 0,
    })
    const evaId = created.json().id as string

    const duplicateName = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: headers(diana),
      payload: { name: 'eva', roles: ['REVIEWER'] },
    })
    expect(duplicateName.statusCode).toBe(409)
    expect(duplicateName.json().error.code).toBe('USER_NAME_EXISTS')

    const removeLastAdmin = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER_IDS.diana}`,
      headers: headers(diana),
      payload: { name: 'Diana', roles: ['REVIEWER'] },
    })
    expect(removeLastAdmin.statusCode).toBe(409)
    expect(removeLastAdmin.json().error.code).toBe('LAST_ADMIN_REQUIRED')

    const promoteEva = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${evaId}`,
      headers: headers(diana),
      payload: { name: 'Eva Admin', roles: ['SUBMITTER', 'ADMIN'] },
    })
    expect(promoteEva.statusCode).toBe(200)
    expect(promoteEva.json().roles).toEqual(['ADMIN', 'SUBMITTER'])

    const demoteSelf = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER_IDS.diana}`,
      headers: headers(diana),
      payload: { name: 'Diana', roles: ['REVIEWER'] },
    })
    expect(demoteSelf.statusCode).toBe(200)

    const noLongerAdmin = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: diana },
    })
    expect(noLongerAdmin.statusCode).toBe(403)

    const eva = await sessionCookie(evaId)
    const managedUsers = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: eva },
    })
    expect(managedUsers.statusCode).toBe(200)
    expect(managedUsers.json()).toHaveLength(5)
  })

  it('does not allow role changes to strand an open review round', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const bob = await sessionCookie(USER_IDS.bob)
    const chen = await sessionCookie(USER_IDS.chen)
    const diana = await sessionCookie(USER_IDS.diana)
    const draft = await createContent(alice, 'Role safety', 'Body', 'HIGH')
    const submitted = await submitContent(alice, draft.content.id, draft.content.version)

    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER_IDS.bob}`,
      headers: headers(diana),
      payload: { name: 'Bob', roles: ['ADMIN'] },
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error.code).toBe(
      'ROLE_CHANGE_WOULD_BLOCK_OPEN_ROUND',
    )

    await decide(bob, submitted.history[0].id, 'APPROVE')
    const afterExistingDecision = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER_IDS.bob}`,
      headers: headers(diana),
      payload: { name: 'Bob', roles: ['ADMIN'] },
    })
    expect(afterExistingDecision.statusCode).toBe(200)
    expect(afterExistingDecision.json().roles).toEqual(['ADMIN'])

    const completed = await decide(chen, submitted.history[0].id, 'APPROVE')
    expect((completed.json() as DetailResponse).content.status).toBe('APPROVED')
  })

  it('preserves historical names when an admin renames users', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const bob = await sessionCookie(USER_IDS.bob)
    const diana = await sessionCookie(USER_IDS.diana)
    const draft = await createContent(alice, 'Name snapshot', 'Body', 'LOW')
    const submitted = await submitContent(alice, draft.content.id, draft.content.version)
    await decide(bob, submitted.history[0].id, 'APPROVE')

    const renameAlice = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER_IDS.alice}`,
      headers: headers(diana),
      payload: {
        name: 'Alice Renamed',
        roles: ['SUBMITTER', 'REVIEWER'],
      },
    })
    expect(renameAlice.statusCode).toBe(200)
    const renameBob = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER_IDS.bob}`,
      headers: headers(diana),
      payload: { name: 'Bob Renamed', roles: ['REVIEWER'] },
    })
    expect(renameBob.statusCode).toBe(200)

    const detail = await getDetail(diana, draft.content.id)
    expect(detail.content.author?.name).toBe('Alice Renamed')
    expect(detail.history[0].snapshot.authorName).toBe('Alice')
    expect(detail.history[0].decisions[0].reviewer?.name).toBe('Bob')
  })

  it('rejects client-supplied identity and workflow fields on write contracts', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const bob = await sessionCookie(USER_IDS.bob)
    const invalidCreate = await app.inject({
      method: 'POST',
      url: '/api/contents',
      headers: headers(alice),
      payload: {
        title: 'Forged',
        body: 'Body',
        risk: 'LOW',
        authorId: USER_IDS.bob,
      },
    })
    expect(invalidCreate.statusCode).toBe(400)
    expect(invalidCreate.json().error.code).toBe('INVALID_REQUEST')

    const draft = await createContent(alice, 'Strict contract', 'Body', 'LOW')
    const invalidEdit = await app.inject({
      method: 'PATCH',
      url: `/api/contents/${draft.content.id}`,
      headers: headers(alice),
      payload: {
        title: 'Changed',
        body: 'Body',
        risk: 'LOW',
        status: 'APPROVED',
        expectedVersion: draft.content.version,
      },
    })
    expect(invalidEdit.statusCode).toBe(400)

    const invalidSubmit = await app.inject({
      method: 'POST',
      url: `/api/contents/${draft.content.id}/submit`,
      headers: headers(alice),
      payload: { expectedVersion: draft.content.version, requiredApprovals: 1 },
    })
    expect(invalidSubmit.statusCode).toBe(400)

    const submitted = await submitContent(alice, draft.content.id, draft.content.version)
    const invalidDecision = await app.inject({
      method: 'POST',
      url: `/api/review-rounds/${submitted.history[0].id}/decisions`,
      headers: headers(bob),
      payload: {
        decision: 'APPROVE',
        reviewerId: USER_IDS.alice,
      },
    })
    expect(invalidDecision.statusCode).toBe(400)
    expect((await getDetail(alice, draft.content.id)).history[0].decisions).toHaveLength(0)
  })

  it('rejects a stale tab even after the content returns to an editable state', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const bob = await sessionCookie(USER_IDS.bob)
    const draft = await createContent(alice, 'Old tab', 'Original', 'LOW')
    const staleVersion = draft.content.version
    const submitted = await submitContent(alice, draft.content.id, staleVersion)
    await decide(bob, submitted.history[0].id, 'REJECT', 'Revise it')

    const staleEdit = await app.inject({
      method: 'PATCH',
      url: `/api/contents/${draft.content.id}`,
      headers: headers(alice),
      payload: {
        title: 'Overwritten from stale tab',
        body: 'Stale',
        risk: 'LOW',
        expectedVersion: staleVersion,
      },
    })
    expect(staleEdit.statusCode).toBe(409)
    expect(staleEdit.json().error.code).toBe('STALE_VERSION')
    const current = await getDetail(alice, draft.content.id)
    expect(current.content.title).toBe('Old tab')
    expect(current.content.status).toBe('REJECTED')
  })

  it('rolls back snapshot, round and idempotency when submission fails mid-transaction', async () => {
    const alice = await sessionCookie(USER_IDS.alice)
    const draft = await createContent(alice, 'Atomic submit', 'Body', 'LOW')
    database.exec(`
      CREATE TRIGGER inject_submission_failure
      BEFORE UPDATE OF status ON contents
      WHEN NEW.status = 'IN_REVIEW'
      BEGIN
        SELECT RAISE(ABORT, 'injected submission failure');
      END;
    `)
    const key = randomUUID()
    const request = {
      method: 'POST' as const,
      url: `/api/contents/${draft.content.id}/submit`,
      headers: headers(alice, key),
      payload: { expectedVersion: draft.content.version },
    }

    const failed = await app.inject(request)
    expect(failed.statusCode).toBe(500)
    const facts = database
      .prepare(`
        SELECT
          (SELECT count(*) FROM content_revisions) AS revisions,
          (SELECT count(*) FROM review_rounds) AS rounds,
          (
            SELECT count(*) FROM idempotency_requests
            WHERE operation LIKE 'SUBMIT_CONTENT:%'
          ) AS idempotency,
          (SELECT status FROM contents WHERE id = ?) AS status
      `)
      .get(draft.content.id) as unknown as {
        revisions: number
        rounds: number
        idempotency: number
        status: string
      }
    expect(facts).toEqual({
      revisions: 0,
      rounds: 0,
      idempotency: 0,
      status: 'DRAFT',
    })

    database.exec('DROP TRIGGER inject_submission_failure')
    const retry = await app.inject(request)
    expect(retry.statusCode).toBe(201)
    expect(retry.headers['idempotency-replayed']).toBe('false')
  })

  it('stops persistent growth when public demo capacity is exhausted', async () => {
    const limitedDatabase = createDatabase(':memory:')
    const limitedApp = await buildApp({
      database: limitedDatabase,
      sessionSecret: 'limited-session-secret-with-enough-length',
      capacityLimits: {
        maxUsers: 5,
        maxContents: 1,
        maxRoundsPerContent: 1,
      },
    })

    try {
      const aliceResponse = await limitedApp.inject({
        method: 'POST',
        url: '/api/session/switch',
        payload: { userId: USER_IDS.alice },
      })
      const aliceCookie = String(aliceResponse.headers['set-cookie']).split(';')[0]
      const first = await limitedApp.inject({
        method: 'POST',
        url: '/api/contents',
        headers: headers(aliceCookie),
        payload: { title: 'Within capacity', body: 'Body', risk: 'LOW' },
      })
      expect(first.statusCode).toBe(201)

      const blocked = await limitedApp.inject({
        method: 'POST',
        url: '/api/contents',
        headers: headers(aliceCookie),
        payload: { title: 'Over capacity', body: 'Body', risk: 'LOW' },
      })
      expect(blocked.statusCode).toBe(507)
      expect(blocked.json().error.code).toBe('CAPACITY_LIMIT_REACHED')

      const firstDetail = first.json() as DetailResponse
      const submitted = await limitedApp.inject({
        method: 'POST',
        url: `/api/contents/${firstDetail.content.id}/submit`,
        headers: headers(aliceCookie),
        payload: { expectedVersion: firstDetail.content.version },
      })
      expect(submitted.statusCode).toBe(201)
      const bobResponse = await limitedApp.inject({
        method: 'POST',
        url: '/api/session/switch',
        payload: { userId: USER_IDS.bob },
      })
      const bobCookie = String(bobResponse.headers['set-cookie']).split(';')[0]
      const rejected = await limitedApp.inject({
        method: 'POST',
        url: `/api/review-rounds/${submitted.json().history[0].id}/decisions`,
        headers: headers(bobCookie),
        payload: { decision: 'REJECT', comment: 'Revise' },
      })
      expect(rejected.statusCode).toBe(200)
      const roundBlocked = await limitedApp.inject({
        method: 'POST',
        url: `/api/contents/${firstDetail.content.id}/submit`,
        headers: headers(aliceCookie),
        payload: { expectedVersion: rejected.json().content.version },
      })
      expect(roundBlocked.statusCode).toBe(507)
      expect(roundBlocked.json().error.code).toBe('CAPACITY_LIMIT_REACHED')

      const dianaResponse = await limitedApp.inject({
        method: 'POST',
        url: '/api/session/switch',
        payload: { userId: USER_IDS.diana },
      })
      const dianaCookie = String(dianaResponse.headers['set-cookie']).split(';')[0]
      const eva = await limitedApp.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: headers(dianaCookie),
        payload: { name: 'Eva', roles: ['SUBMITTER'] },
      })
      expect(eva.statusCode).toBe(201)
      const userBlocked = await limitedApp.inject({
        method: 'POST',
        url: '/api/admin/users',
        headers: headers(dianaCookie),
        payload: { name: 'Frank', roles: ['REVIEWER'] },
      })
      expect(userBlocked.statusCode).toBe(507)
      expect(userBlocked.json().error.code).toBe('CAPACITY_LIMIT_REACHED')

      const facts = limitedDatabase.prepare(`
        SELECT
          (SELECT count(*) FROM contents) AS contents,
          (SELECT count(*) FROM content_revisions) AS revisions,
          (SELECT count(*) FROM review_rounds) AS rounds,
          (SELECT count(*) FROM review_decisions) AS decisions,
          (SELECT count(*) FROM users) AS users
      `).get()
      expect(facts).toEqual({
        contents: 1,
        revisions: 1,
        rounds: 1,
        decisions: 1,
        users: 5,
      })
      const pageSize = limitedDatabase.prepare('PRAGMA page_size').get() as {
        page_size: number
      }
      const maxPages = limitedDatabase.prepare('PRAGMA max_page_count').get() as {
        max_page_count: number
      }
      const autoCheckpoint = limitedDatabase
        .prepare('PRAGMA wal_autocheckpoint')
        .get() as { wal_autocheckpoint: number }
      const journalLimit = limitedDatabase
        .prepare('PRAGMA journal_size_limit')
        .get() as { journal_size_limit: number }
      expect(maxPages.max_page_count * pageSize.page_size).toBeLessThanOrEqual(
        defaultCapacityLimits.maxDatabaseBytes,
      )
      expect(autoCheckpoint.wal_autocheckpoint).toBe(256)
      expect(journalLimit.journal_size_limit).toBeLessThanOrEqual(8 * 1024 * 1024)
    } finally {
      await limitedApp.close()
      limitedDatabase.close()
    }
  })

  it('rate limits public writes before they can consume persistent capacity', async () => {
    const limitedDatabase = createDatabase(':memory:')
    const limitedApp = await buildApp({
      database: limitedDatabase,
      sessionSecret: 'rate-limit-session-secret-with-enough-length',
      writeRateLimitMax: 2,
    })

    try {
      const forwardedIp = '203.0.113.10'
      const switched = await limitedApp.inject({
        method: 'POST',
        url: '/api/session/switch',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': forwardedIp },
        payload: { userId: USER_IDS.alice },
      })
      expect(switched.statusCode).toBe(200)
      const cookie = String(switched.headers['set-cookie']).split(';')[0]
      const created = await limitedApp.inject({
        method: 'POST',
        url: '/api/contents',
        remoteAddress: '127.0.0.1',
        headers: {
          cookie,
          'idempotency-key': randomUUID(),
          'x-forwarded-for': forwardedIp,
        },
        payload: { title: 'Allowed', body: 'Body', risk: 'LOW' },
      })
      expect(created.statusCode).toBe(201)

      const blocked = await limitedApp.inject({
        method: 'PATCH',
        url: `/api/contents/${created.json().content.id}`,
        remoteAddress: '127.0.0.1',
        headers: {
          cookie,
          'idempotency-key': randomUUID(),
          'x-forwarded-for': forwardedIp,
        },
        payload: {
          title: 'Blocked',
          body: 'Body',
          risk: 'LOW',
          expectedVersion: created.json().content.version,
        },
      })
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json().error.code).toBe('RATE_LIMITED')

      const facts = limitedDatabase.prepare(`
        SELECT
          (SELECT count(*) FROM contents) AS contents,
          (SELECT count(*) FROM idempotency_requests) AS idempotency
      `).get()
      expect(facts).toEqual({ contents: 1, idempotency: 1 })
    } finally {
      await limitedApp.close()
      limitedDatabase.close()
    }
  })

  it('bounds idempotency storage while allowing expired records to be reclaimed', async () => {
    const limitedDatabase = createDatabase(':memory:')
    const limitedApp = await buildApp({
      database: limitedDatabase,
      sessionSecret: 'idempotency-cap-session-secret-with-enough-length',
      capacityLimits: {
        maxIdempotencyRecords: 1,
        idempotencyTtlHours: 1,
      },
    })

    try {
      limitedDatabase.prepare(`
        INSERT INTO idempotency_requests (
          actor_id, operation, idempotency_key, request_hash,
          status_code, response_body, created_at
        ) VALUES (?, 'OLD_OPERATION', 'old-idempotency-key', 'hash', 200, '{}', ?)
      `).run(USER_IDS.alice, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())

      const created = await limitedApp.inject({
        method: 'POST',
        url: '/api/contents',
        headers: { 'idempotency-key': randomUUID() },
        payload: { title: 'After cleanup', body: 'Body', risk: 'LOW' },
      })
      expect(created.statusCode).toBe(201)

      const blocked = await limitedApp.inject({
        method: 'PATCH',
        url: `/api/contents/${created.json().content.id}`,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          title: 'No more idempotency capacity',
          body: 'Body',
          risk: 'LOW',
          expectedVersion: created.json().content.version,
        },
      })
      expect(blocked.statusCode).toBe(507)

      const facts = limitedDatabase.prepare(`
        SELECT
          (SELECT count(*) FROM contents) AS contents,
          (SELECT count(*) FROM idempotency_requests) AS idempotency
      `).get()
      expect(facts).toEqual({ contents: 1, idempotency: 1 })
    } finally {
      await limitedApp.close()
      limitedDatabase.close()
    }
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

  async function getWorkspace(cookie: string): Promise<WorkspaceResponse> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    return response.json() as WorkspaceResponse
  }
})