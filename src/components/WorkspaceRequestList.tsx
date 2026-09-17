import {
  ArrowDownUp,
  Clock3,
  Inbox,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import type {
  ContentStatus,
  Risk,
  WorkspaceItem,
  WorkspaceSort,
} from '../types'

type StatusFilter = 'ALL' | ContentStatus
type RiskFilter = 'ALL' | Risk

interface WorkspaceRequestListProps {
  title: string
  description: string
  items: WorkspaceItem[]
  totalCount: number
  selectedId: string | null
  query: string
  statusFilter: StatusFilter
  riskFilter: RiskFilter
  sort: WorkspaceSort
  loading: boolean
  busy: boolean
  emptyTitle: string
  emptyDescription: string
  onQueryChange: (query: string) => void
  onFiltersChange: (status: StatusFilter, risk: RiskFilter) => void
  onSortChange: (sort: WorkspaceSort) => void
  onResetFilters: () => void
  onSelect: (contentId: string) => void
  onRefresh: () => void
}

const statusLabels = {
  DRAFT: '草稿',
  IN_REVIEW: '审核中',
  APPROVED: '已通过',
  REJECTED: '已拒绝',
} as const

const queueLabels = {
  MINE: '我发起',
  PENDING_REVIEW: '待处理',
  REVIEWED: '已参与',
  ADMIN: '全量',
} as const

const compactDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

export function WorkspaceRequestList({
  title,
  description,
  items,
  totalCount,
  selectedId,
  query,
  statusFilter,
  riskFilter,
  sort,
  loading,
  busy,
  emptyTitle,
  emptyDescription,
  onQueryChange,
  onFiltersChange,
  onSortChange,
  onResetFilters,
  onSelect,
  onRefresh,
}: WorkspaceRequestListProps) {
  const searchRef = useRef<HTMLInputElement>(null)
  const hasFilters =
    query.trim().length > 0 || statusFilter !== 'ALL' || riskFilter !== 'ALL'

  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isFormField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT'
      if (
        !isFormField &&
        (event.key === '/' || (event.metaKey && event.key.toLowerCase() === 'k'))
      ) {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  function moveSelection(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const currentIndex = items.findIndex((item) => item.id === selectedId)
    const direction = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex =
      currentIndex < 0
        ? 0
        : Math.min(items.length - 1, Math.max(0, currentIndex + direction))
    const next = items[nextIndex]
    if (!next) return
    onSelect(next.id)
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(`[data-request-index="${nextIndex}"]`)
        ?.focus()
    })
  }

  const quickFilter =
    statusFilter === 'IN_REVIEW' && riskFilter === 'ALL'
      ? 'IN_REVIEW'
      : statusFilter === 'ALL' && riskFilter === 'HIGH'
        ? 'HIGH'
        : statusFilter === 'REJECTED' && riskFilter === 'ALL'
          ? 'REJECTED'
          : statusFilter === 'ALL' && riskFilter === 'ALL'
            ? 'ALL'
            : 'CUSTOM'

  return (
    <aside className="list-pane" aria-label="审核请求清单">
      <header className="list-header">
        <div>
          <span className="section-kicker">REQUEST QUEUE</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="list-header-actions">
          <span className="item-count" title="当前结果 / 队列总数">
            {items.length === totalCount ? totalCount : `${items.length}/${totalCount}`}
          </span>
          <button
            type="button"
            className="icon-button"
            title="刷新请求"
            aria-label="刷新请求"
            disabled={loading || busy}
            onClick={onRefresh}
          >
            <RefreshCw className={loading ? 'spinning' : ''} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="request-toolbar">
        <label className="search-field">
          <span className="sr-only">搜索标题或作者</span>
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="搜索标题、作者"
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <kbd>⌘ K</kbd>
        </label>

        <div className="filter-row">
          <label className="compact-select">
            <SlidersHorizontal aria-hidden="true" />
            <span className="sr-only">状态筛选</span>
            <select
              value={statusFilter}
              onChange={(event) =>
                onFiltersChange(event.target.value as StatusFilter, riskFilter)
              }
            >
              <option value="ALL">全部状态</option>
              <option value="DRAFT">草稿</option>
              <option value="IN_REVIEW">审核中</option>
              <option value="APPROVED">已通过</option>
              <option value="REJECTED">已拒绝</option>
            </select>
          </label>
          <label className="compact-select">
            <span className="sr-only">风险筛选</span>
            <select
              value={riskFilter}
              onChange={(event) =>
                onFiltersChange(statusFilter, event.target.value as RiskFilter)
              }
            >
              <option value="ALL">全部风险</option>
              <option value="LOW">低风险</option>
              <option value="HIGH">高风险</option>
            </select>
          </label>
          <label className="compact-select sort-select">
            <ArrowDownUp aria-hidden="true" />
            <span className="sr-only">请求排序</span>
            <select
              value={sort}
              onChange={(event) => onSortChange(event.target.value as WorkspaceSort)}
            >
              <option value="PRIORITY">智能优先级</option>
              <option value="UPDATED_DESC">最近更新</option>
              <option value="UPDATED_ASC">最早更新</option>
              <option value="TITLE_ASC">标题排序</option>
            </select>
          </label>
          <button
            type="button"
            className="reset-filter-button"
            title="重置搜索、状态和风险筛选"
            disabled={!hasFilters}
            onClick={onResetFilters}
          >
            <RotateCcw aria-hidden="true" />
            重置筛选
          </button>
        </div>

        <div className="quick-filters" aria-label="快捷筛选">
          <button
            type="button"
            className={quickFilter === 'ALL' ? 'active' : ''}
            onClick={() => onFiltersChange('ALL', 'ALL')}
          >
            全部
          </button>
          <button
            type="button"
            className={quickFilter === 'IN_REVIEW' ? 'active' : ''}
            onClick={() => onFiltersChange('IN_REVIEW', 'ALL')}
          >
            审核中
          </button>
          <button
            type="button"
            className={quickFilter === 'HIGH' ? 'active' : ''}
            onClick={() => onFiltersChange('ALL', 'HIGH')}
          >
            高风险
          </button>
          <button
            type="button"
            className={quickFilter === 'REJECTED' ? 'active' : ''}
            onClick={() => onFiltersChange('REJECTED', 'ALL')}
          >
            已拒绝
          </button>
        </div>
      </div>

      <div className="request-list-columns" aria-hidden="true">
        <span>请求</span>
        <span>审核进度</span>
      </div>

      {loading && totalCount === 0 ? (
        <div className="request-skeletons" aria-label="正在加载请求">
          {[0, 1, 2, 3, 4].map((item) => (
            <span key={item} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <Inbox aria-hidden="true" />
          </span>
          <strong>{hasFilters ? '没有匹配的请求' : emptyTitle}</strong>
          <p>{hasFilters ? '调整条件或点击“重置筛选”后重试。' : emptyDescription}</p>
          {hasFilters && (
            <button type="button" className="button secondary compact-button" onClick={onResetFilters}>
              清除筛选
            </button>
          )}
        </div>
      ) : (
        <div
          className="request-list"
          role="listbox"
          aria-label={`${title}请求`}
          onKeyDown={moveSelection}
        >
          {items.map((item, index) => {
            const approvalPercent = item.currentRound
              ? Math.min(
                  100,
                  (item.currentRound.approvalCount /
                    item.currentRound.requiredApprovals) *
                    100,
                )
              : 0
            return (
              <button
                type="button"
                role="option"
                aria-selected={selectedId === item.id}
                data-request-index={index}
                key={item.id}
                className={`request-row ${selectedId === item.id ? 'selected' : ''}`}
                disabled={busy}
                onClick={() => onSelect(item.id)}
              >
                <span className={`request-risk-marker risk-${item.risk.toLowerCase()}`} />
                <span className="request-main">
                  <span className="request-title-line">
                    <strong>{item.title}</strong>
                    <span className={`status-pill status-${item.status.toLowerCase()}`}>
                      {statusLabels[item.status]}
                    </span>
                  </span>
                  <span className="request-meta">
                    <span className="author-avatar" aria-hidden="true">
                      {item.author.name.slice(0, 1).toLocaleUpperCase()}
                    </span>
                    <span>{item.author.name}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.risk === 'HIGH' ? '高风险' : '低风险'}</span>
                    {item.queues
                      .filter((queue) => queue !== 'ADMIN')
                      .slice(0, 2)
                      .map((queue) => (
                        <span className="queue-tag" key={queue}>
                          {queueLabels[queue]}
                        </span>
                      ))}
                  </span>
                  <span className="request-updated">
                    <Clock3 aria-hidden="true" />
                    {compactDateFormatter.format(new Date(item.updatedAt))}
                  </span>
                </span>
                <span className="request-progress">
                  {item.currentRound ? (
                    <>
                      <strong>
                        {item.currentRound.approvalCount}/
                        {item.currentRound.requiredApprovals}
                      </strong>
                      <small>R{item.currentRound.roundNo} · {item.roundCount} 轮</small>
                      <span className="mini-progress">
                        <i style={{ width: `${approvalPercent}%` }} />
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>—</strong>
                      <small>尚未提交</small>
                    </>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <footer className="list-footer">
        <span>↑↓ 切换请求</span>
        <span>{items.length} 条结果</span>
      </footer>
    </aside>
  )
}

export type { RiskFilter, StatusFilter }
