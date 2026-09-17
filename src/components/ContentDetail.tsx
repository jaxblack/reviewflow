import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  History,
  Pencil,
  Send,
  UserRound,
  XCircle,
} from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '../api'
import type { ContentDetail as ContentDetailData, DecisionType } from '../types'

interface ContentDetailProps {
  detail: ContentDetailData
  busy: boolean
  onEdit: () => void
  onSubmit: () => Promise<void>
  onDecision: (decision: DecisionType, comment: string) => Promise<void>
}

const statusLabels = {
  DRAFT: '草稿',
  IN_REVIEW: '审核中',
  APPROVED: '已通过',
  REJECTED: '已拒绝',
  OPEN: '进行中',
} as const

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function ContentDetail({
  detail,
  busy,
  onEdit,
  onSubmit,
  onDecision,
}: ContentDetailProps) {
  const [comment, setComment] = useState('')
  const [decisionError, setDecisionError] = useState('')
  const { content, capabilities, history } = detail
  const currentRound = history[0]
  const progress = currentRound
    ? Math.min(100, (currentRound.approvalCount / currentRound.requiredApprovals) * 100)
    : 0

  async function decide(decision: DecisionType) {
    setDecisionError('')
    if (decision === 'REJECT' && comment.trim().length === 0) {
      setDecisionError('拒绝时必须填写理由')
      return
    }
    try {
      await onDecision(decision, comment)
      setComment('')
    } catch (decisionFailure) {
      setDecisionError(errorMessage(decisionFailure))
    }
  }

  return (
    <article className="detail-panel">
      <header className="detail-header">
        <div className="detail-title">
          <div className="badge-row">
            <span className={`status-badge status-${content.status.toLowerCase()}`}>
              {statusLabels[content.status]}
            </span>
            <span className={`risk-badge risk-${content.risk.toLowerCase()}`}>
              {content.risk}
            </span>
          </div>
          <h2>{content.title}</h2>
          <p className="byline">
            <UserRound aria-hidden="true" />
            {content.author.name}
            <span>·</span>
            更新于 {dateFormatter.format(new Date(content.updatedAt))}
          </p>
        </div>
        <div className="detail-actions">
          {capabilities.canEdit && (
            <button type="button" className="button secondary" disabled={busy} onClick={onEdit}>
              <Pencil aria-hidden="true" />
              编辑
            </button>
          )}
          {capabilities.canSubmit && (
            <button type="button" className="button primary" disabled={busy} onClick={onSubmit}>
              <Send aria-hidden="true" />
              {busy ? '提交中…' : '提交审核'}
            </button>
          )}
        </div>
      </header>

      {content.viewingSubmittedSnapshot && (
        <p className="snapshot-notice">
          <History aria-hidden="true" />
          当前展示最近一次提交的快照，未提交的修改仅作者和管理员可见。
        </p>
      )}

      <section className="content-body" aria-label="内容正文">
        {content.body}
      </section>

      {currentRound && (
        <section className="review-progress" aria-labelledby="progress-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">ROUND {currentRound.roundNo}</p>
              <h3 id="progress-title">当前审核进度</h3>
            </div>
            <span className={`round-result result-${currentRound.status.toLowerCase()}`}>
              {statusLabels[currentRound.status]}
            </span>
          </div>
          <div className="progress-copy">
            <strong>
              {currentRound.approvalCount} / {currentRound.requiredApprovals}
            </strong>
            <span>位审核人已通过</span>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={currentRound.requiredApprovals}
            aria-valuenow={currentRound.approvalCount}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
        </section>
      )}

      {capabilities.canReview && currentRound && (
        <section className="decision-panel" aria-labelledby="decision-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR DECISION</p>
              <h3 id="decision-title">提交审核决定</h3>
            </div>
          </div>
          <label>
            <span>审核意见（拒绝时必填）</span>
            <textarea
              rows={3}
              maxLength={2_000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          {decisionError && <p className="inline-error">{decisionError}</p>}
          <div className="decision-actions">
            <button
              type="button"
              className="button approve"
              disabled={busy}
              onClick={() => void decide('APPROVE')}
            >
              <Check aria-hidden="true" />
              通过
            </button>
            <button
              type="button"
              className="button reject"
              disabled={busy}
              onClick={() => void decide('REJECT')}
            >
              <XCircle aria-hidden="true" />
              拒绝
            </button>
          </div>
        </section>
      )}

      <section className="history-section" aria-labelledby="history-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">AUDIT TRAIL</p>
            <h3 id="history-title">审核历史</h3>
          </div>
          <span className="round-count">{history.length} 轮</span>
        </div>

        {history.length === 0 ? (
          <p className="empty-inline">尚未提交审核</p>
        ) : (
          <div className="history-list">
            {history.map((round, index) => (
              <details key={round.id} className="history-round" open={index === 0}>
                <summary>
                  <span className="round-index">R{round.roundNo}</span>
                  <span>{round.snapshot.title}</span>
                  <span className={`round-result result-${round.status.toLowerCase()}`}>
                    {statusLabels[round.status]}
                  </span>
                </summary>
                <div className="round-content">
                  <div className="snapshot-meta">
                    <span className={`risk-badge risk-${round.snapshot.risk.toLowerCase()}`}>
                      {round.snapshot.risk}
                    </span>
                    <span>
                      <Clock3 aria-hidden="true" />
                      {dateFormatter.format(new Date(round.startedAt))}
                    </span>
                  </div>
                  <p className="snapshot-body">{round.snapshot.body}</p>
                  <div className="decision-history">
                    {round.decisions.length === 0 ? (
                      <p className="empty-inline">尚无审核决定</p>
                    ) : (
                      round.decisions.map((decision) => (
                        <div className="decision-row" key={decision.id}>
                          {decision.decision === 'APPROVE' ? (
                            <CheckCircle2 className="decision-ok" aria-hidden="true" />
                          ) : (
                            <AlertTriangle className="decision-no" aria-hidden="true" />
                          )}
                          <div>
                            <strong>{decision.reviewer.name}</strong>
                            <span>
                              {decision.decision === 'APPROVE' ? '通过' : '拒绝'} ·{' '}
                              {dateFormatter.format(new Date(decision.createdAt))}
                            </span>
                            {decision.comment && <p>{decision.comment}</p>}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </article>
  )
}