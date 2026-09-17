import {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  FileClock,
  FileText,
  GitBranch,
  History,
  Pencil,
  RotateCcw,
  Send,
  UserRound,
  XCircle,
} from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '../api'
import type {
  ContentDetail as ContentDetailData,
  DecisionType,
  ReviewRound,
} from '../types'

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
  const latestRound = history[0]
  const remainingApprovals = latestRound
    ? Math.max(0, latestRound.requiredApprovals - latestRound.approvalCount)
    : 0
  const progress = latestRound
    ? Math.min(100, (latestRound.approvalCount / latestRound.requiredApprovals) * 100)
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
            <span className="version-badge">v{content.version}</span>
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
              编辑工作副本
            </button>
          )}
          {capabilities.canSubmit && (
            <button type="button" className="button primary" disabled={busy} onClick={onSubmit}>
              {content.status === 'REJECTED' ? (
                <RotateCcw aria-hidden="true" />
              ) : (
                <Send aria-hidden="true" />
              )}
              {busy
                ? '提交中…'
                : content.status === 'REJECTED'
                  ? '重新提交'
                  : '提交审核'}
            </button>
          )}
        </div>
      </header>

      <section className="content-facts" aria-label="请求基本信息">
        <span>
          <CalendarDays aria-hidden="true" />
          <small>创建时间</small>
          <strong>{dateFormatter.format(new Date(content.createdAt))}</strong>
        </span>
        <span>
          <GitBranch aria-hidden="true" />
          <small>审核轮次</small>
          <strong>{history.length} 轮</strong>
        </span>
        <span>
          <FileClock aria-hidden="true" />
          <small>最近流转</small>
          <strong>
            {latestRound
              ? `R${latestRound.roundNo} · ${statusLabels[latestRound.status]}`
              : '尚未提交'}
          </strong>
        </span>
      </section>

      <RequestFlow detail={detail} />

      {content.viewingSubmittedSnapshot ? (
        <p className="snapshot-notice">
          <History aria-hidden="true" />
          当前展示最近一次提交的不可变快照；作者拒绝后所做的未提交修改不会泄露给审核人。
        </p>
      ) : capabilities.canEdit ? (
        <p className="working-copy-notice">
          <FileText aria-hidden="true" />
          当前展示作者工作副本。提交时会生成新的不可变快照和独立审核轮次。
        </p>
      ) : null}

      <section className="content-section" aria-labelledby="content-body-title">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">CURRENT CONTENT</p>
            <h3 id="content-body-title">
              {content.viewingSubmittedSnapshot ? '最近提交内容' : '当前内容'}
            </h3>
          </div>
        </div>
        <div className="content-body">{content.body}</div>
      </section>

      {latestRound && (
        <section className="review-progress" aria-labelledby="progress-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">ROUND {latestRound.roundNo}</p>
              <h3 id="progress-title">
                {latestRound.status === 'OPEN' ? '当前审核进度' : '最近一轮结果'}
              </h3>
            </div>
            <span className={`round-result result-${latestRound.status.toLowerCase()}`}>
              {statusLabels[latestRound.status]}
            </span>
          </div>

          <div className="progress-stats">
            <span>
              <strong>{latestRound.approvalCount}</strong>
              <small>已通过票</small>
            </span>
            <span>
              <strong>{latestRound.requiredApprovals}</strong>
              <small>所需票数</small>
            </span>
            <span>
              <strong>
                {latestRound.status === 'OPEN' ? remainingApprovals : '—'}
              </strong>
              <small>仍需通过</small>
            </span>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={latestRound.requiredApprovals}
            aria-valuenow={latestRound.approvalCount}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
          <p className={`progress-explanation progress-${latestRound.status.toLowerCase()}`}>
            {latestRound.status === 'OPEN' &&
              `本轮还需要 ${remainingApprovals} 位不同审核人通过；任意合法拒绝都会立即结束本轮。`}
            {latestRound.status === 'APPROVED' &&
              `本轮已达到 ${latestRound.requiredApprovals} 票通过阈值，内容进入不可编辑终态。`}
            {latestRound.status === 'REJECTED' &&
              '本轮因拒绝结束；已有通过票作为真实历史保留，但不会计入下一轮。'}
          </p>
        </section>
      )}

      {capabilities.canReview && latestRound && (
        <section className="decision-panel" aria-labelledby="decision-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR DECISION</p>
              <h3 id="decision-title">提交审核决定</h3>
            </div>
            <span className="decision-once">本轮仅可决定一次</span>
          </div>
          <label>
            <span>审核意见（通过可选，拒绝必填）</span>
            <textarea
              rows={3}
              maxLength={2_000}
              value={comment}
              placeholder="填写判断依据，便于提交人修改和后续审计"
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
            <p className="eyebrow">IMMUTABLE AUDIT TRAIL</p>
            <h3 id="history-title">完整审核历史</h3>
          </div>
          <span className="round-count">{history.length} 轮</span>
        </div>

        {history.length === 0 ? (
          <div className="empty-history">
            <FileText aria-hidden="true" />
            <div>
              <strong>尚未形成审核历史</strong>
              <p>首次提交后，这里会保存当时内容快照和每一项审核决定。</p>
            </div>
          </div>
        ) : (
          <div className="history-list">
            {history.map((round, index) => (
              <RoundHistory key={round.id} round={round} open={index === 0} />
            ))}
          </div>
        )}
      </section>
    </article>
  )
}

function RequestFlow({ detail }: { detail: ContentDetailData }) {
  const { content, history } = detail
  const latestRound = history[0]
  const hasSubmitted = Boolean(latestRound)
  const isReviewing = content.status === 'IN_REVIEW'
  const isTerminal = content.status === 'APPROVED' || content.status === 'REJECTED'

  return (
    <section className="request-flow" aria-labelledby="flow-title">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">LIFECYCLE</p>
          <h3 id="flow-title">请求流转</h3>
        </div>
        {content.status === 'REJECTED' && (
          <span className="flow-next">可修改后进入新轮次</span>
        )}
      </div>
      <div className="flow-steps">
        <div className={`flow-step ${hasSubmitted ? 'complete' : 'active'}`}>
          <span>1</span>
          <div>
            <strong>{content.status === 'REJECTED' ? '工作副本可修改' : '内容准备'}</strong>
            <small>{hasSubmitted ? '已形成提交快照' : '草稿尚未提交'}</small>
          </div>
        </div>
        <div className={`flow-step ${isReviewing ? 'active' : hasSubmitted ? 'complete' : ''}`}>
          <span>2</span>
          <div>
            <strong>{latestRound ? `审核轮次 R${latestRound.roundNo}` : '审核轮次'}</strong>
            <small>
              {latestRound
                ? `${latestRound.approvalCount}/${latestRound.requiredApprovals} 位已通过`
                : '提交时创建独立轮次'}
            </small>
          </div>
        </div>
        <div
          className={`flow-step ${isTerminal ? `active terminal-${content.status.toLowerCase()}` : ''}`}
        >
          <span>3</span>
          <div>
            <strong>{isTerminal ? statusLabels[content.status] : '最终结果'}</strong>
            <small>
              {content.status === 'APPROVED' && '达到本轮通过阈值'}
              {content.status === 'REJECTED' && '任意拒绝结束本轮'}
              {!isTerminal && '等待本轮形成唯一终态'}
            </small>
          </div>
        </div>
      </div>
    </section>
  )
}

function RoundHistory({ round, open }: { round: ReviewRound; open: boolean }) {
  return (
    <details className="history-round" open={open}>
      <summary>
        <span className="round-index">R{round.roundNo}</span>
        <span>
          <strong>{round.snapshot.title}</strong>
          <small>
            {round.approvalCount}/{round.requiredApprovals} 票 ·{' '}
            {dateFormatter.format(new Date(round.startedAt))}
          </small>
        </span>
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
            <UserRound aria-hidden="true" />
            {round.snapshot.authorName}
          </span>
          <span>
            <Clock3 aria-hidden="true" />
            提交于 {dateFormatter.format(new Date(round.snapshot.submittedAt))}
          </span>
          <span>{round.requiredApprovals} 票通过</span>
        </div>
        <p className="snapshot-body">{round.snapshot.body}</p>

        <div className="round-timeline">
          <div className="timeline-row submission-event">
            <Send aria-hidden="true" />
            <div>
              <strong>{round.snapshot.authorName} 提交审核</strong>
              <span>{dateFormatter.format(new Date(round.startedAt))}</span>
            </div>
          </div>
          {round.decisions.length === 0 ? (
            <div className="timeline-row pending-event">
              <Clock3 aria-hidden="true" />
              <div>
                <strong>等待审核决定</strong>
                <span>当前轮次尚无人处理</span>
              </div>
            </div>
          ) : (
            round.decisions.map((decision) => (
              <div className="timeline-row" key={decision.id}>
                {decision.decision === 'APPROVE' ? (
                  <CheckCircle2 className="decision-ok" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="decision-no" aria-hidden="true" />
                )}
                <div>
                  <strong>
                    {decision.reviewer.name}
                    {' · '}
                    {decision.decision === 'APPROVE' ? '给出通过意见' : '拒绝本轮'}
                  </strong>
                  <span>{dateFormatter.format(new Date(decision.createdAt))}</span>
                  {decision.comment ? (
                    <p>{decision.comment}</p>
                  ) : (
                    <p className="muted-comment">未填写审核意见</p>
                  )}
                </div>
              </div>
            ))
          )}
          {round.completedAt && (
            <div className={`timeline-row outcome-event outcome-${round.status.toLowerCase()}`}>
              {round.status === 'APPROVED' ? (
                <CheckCircle2 aria-hidden="true" />
              ) : (
                <XCircle aria-hidden="true" />
              )}
              <div>
                <strong>本轮最终{statusLabels[round.status]}</strong>
                <span>{dateFormatter.format(new Date(round.completedAt))}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </details>
  )
}
