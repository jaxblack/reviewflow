export type Role = 'SUBMITTER' | 'REVIEWER' | 'ADMIN'
export type Risk = 'LOW' | 'HIGH'
export type ContentStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED'
export type RoundStatus = 'OPEN' | 'APPROVED' | 'REJECTED'
export type DecisionType = 'APPROVE' | 'REJECT'
export type ViewKey = 'mine' | 'pending' | 'all'
export type WorkspaceQueue = 'MINE' | 'PENDING_REVIEW' | 'REVIEWED' | 'ADMIN'

export interface User {
  id: string
  name: string
  roles: Role[]
}

export interface AdminUser extends User {
  createdAt: string
  contentCount: number
  decisionCount: number
}

export interface AdminUserInput {
  name: string
  roles: Role[]
}

export interface ReviewProgress {
  id: string
  roundNo: number
  status: RoundStatus
  approvalCount: number
  requiredApprovals: number
}

export interface ContentSummary {
  id: string
  title: string
  risk: Risk
  status: ContentStatus
  version: number
  author: { id: string; name: string }
  createdAt: string
  updatedAt: string
  roundCount: number
  currentRound: ReviewProgress | null
}

export interface WorkspaceItem extends ContentSummary {
  queues: WorkspaceQueue[]
}

export interface Workspace {
  items: WorkspaceItem[]
}

export interface ReviewDecision {
  id: string
  reviewer: { id: string; name: string }
  decision: DecisionType
  comment: string | null
  createdAt: string
}

export interface ReviewRound {
  id: string
  roundNo: number
  status: RoundStatus
  requiredApprovals: number
  approvalCount: number
  startedAt: string
  completedAt: string | null
  snapshot: {
    id: string
    title: string
    body: string
    risk: Risk
    authorName: string
    submittedAt: string
  }
  decisions: ReviewDecision[]
}

export interface ContentDetail {
  content: {
    id: string
    title: string
    body: string
    risk: Risk
    status: ContentStatus
    version: number
    author: { id: string; name: string }
    createdAt: string
    updatedAt: string
    viewingSubmittedSnapshot: boolean
  }
  history: ReviewRound[]
  capabilities: {
    canEdit: boolean
    canSubmit: boolean
    canReview: boolean
    canViewHistory: boolean
  }
}

export interface ContentInput {
  title: string
  body: string
  risk: Risk
}