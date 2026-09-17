import type {
  ContentDetail,
  ContentInput,
  ContentSummary,
  DecisionType,
  User,
} from './types'

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(
    code: string,
    message: string,
    status: number,
  ) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '')
  const response = await fetch(`${basePath}${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  })
  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: { code?: string; message?: string } }
    | null
  if (!response.ok) {
    const errorPayload = payload as { error?: { code?: string; message?: string } } | null
    throw new ApiError(
      errorPayload?.error?.code ?? 'REQUEST_FAILED',
      errorPayload?.error?.message ?? '请求失败，请稍后重试',
      response.status,
    )
  }
  return payload as T
}

function mutationInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body),
  }
}

export const api = {
  users: () => request<User[]>('/api/users'),
  me: () => request<User>('/api/me'),
  switchUser: (userId: string) =>
    request<User>('/api/session/switch', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  listMine: () => request<ContentSummary[]>('/api/contents?scope=mine'),
  listAll: () => request<ContentSummary[]>('/api/contents?scope=all'),
  listPending: () => request<ContentSummary[]>('/api/reviews/pending'),
  detail: (contentId: string) =>
    request<ContentDetail>(`/api/contents/${contentId}`),
  create: (input: ContentInput) =>
    request<ContentDetail>('/api/contents', mutationInit('POST', input)),
  edit: (contentId: string, input: ContentInput, expectedVersion: number) =>
    request<ContentDetail>(
      `/api/contents/${contentId}`,
      mutationInit('PATCH', { ...input, expectedVersion }),
    ),
  submit: (contentId: string, expectedVersion: number) =>
    request<ContentDetail>(
      `/api/contents/${contentId}/submit`,
      mutationInit('POST', { expectedVersion }),
    ),
  decide: (
    roundId: string,
    decision: DecisionType,
    comment: string,
  ) =>
    request<ContentDetail>(
      `/api/review-rounds/${roundId}/decisions`,
      mutationInit('POST', { decision, comment }),
    ),
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}