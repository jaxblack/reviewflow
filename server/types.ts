export type Role = 'SUBMITTER' | 'REVIEWER' | 'ADMIN'
export type Risk = 'LOW' | 'HIGH'
export type ContentStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED'
export type RoundStatus = 'OPEN' | 'APPROVED' | 'REJECTED'
export type DecisionType = 'APPROVE' | 'REJECT'

export interface CurrentUser {
  id: string
  name: string
  roles: Role[]
}

export interface ContentRow {
  id: string
  author_id: string
  title: string
  body: string
  risk: Risk
  status: ContentStatus
  version: number
  created_at: string
  updated_at: string
}

export interface RoundContextRow {
  id: string
  content_id: string
  round_no: number
  revision_id: string
  required_approvals: number
  status: RoundStatus
  started_at: string
  completed_at: string | null
  author_id: string
  content_status: ContentStatus
}

export interface DecisionRow {
  id: string
  round_id: string
  reviewer_id: string
  reviewer_name_snapshot: string
  decision: DecisionType
  comment: string | null
  created_at: string
}