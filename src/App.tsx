import {
  BookOpen,
  Archive,
  ClipboardCheck,
  Clock3,
  FilePlus2,
  Files,
  History,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from './api'
import './App.css'
import { ContentDetail } from './components/ContentDetail'
import { ContentEditor } from './components/ContentEditor'
import { AdminUserPanel } from './components/AdminUserPanel'
import type {
  AdminUser,
  AdminUserInput,
  ContentDetail as ContentDetailData,
  ContentInput,
  ContentStatus,
  DecisionType,
  Risk,
  User,
  WorkspaceItem,
  WorkspaceQueue,
} from './types'

const statusLabels = {
  DRAFT: '草稿',
  IN_REVIEW: '审核中',
  APPROVED: '已通过',
  REJECTED: '已拒绝',
} as const

const queueDefinitions: Array<{
  key: WorkspaceQueue
  title: string
  description: string
  icon: LucideIcon
}> = [
  {
    key: 'PENDING_REVIEW',
    title: '待我审核',
    description: '当前轮次等待你的决定',
    icon: Inbox,
  },
  {
    key: 'MINE',
    title: '我发起的请求',
    description: '从草稿到终态的全部内容',
    icon: Files,
  },
  {
    key: 'REVIEWED',
    title: '我已参与',
    description: '保留我做过决定的审核请求',
    icon: History,
  },
  {
    key: 'ADMIN',
    title: '全部请求',
    description: '管理员全量审计视图',
    icon: ClipboardCheck,
  },
]

type StatusFilter = 'ALL' | ContentStatus
type RiskFilter = 'ALL' | Risk

const compactDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function App() {
  const [users, setUsers] = useState<User[]>([])
  const [me, setMe] = useState<User | null>(null)
  const [items, setItems] = useState<WorkspaceItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ContentDetailData | null>(null)
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null)
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([])
  const [loadingAdmin, setLoadingAdmin] = useState(false)
  const [loadingWorkspace, setLoadingWorkspace] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('ALL')
  const deferredQuery = useDeferredValue(query)
  const initialized = useRef(false)
  const workspaceRequest = useRef(0)
  const detailRequest = useRef(0)

  async function initialize() {
    setLoadingWorkspace(true)
    setError('')
    try {
      const [availableUsers, currentUser] = await Promise.all([api.users(), api.me()])
      setUsers(availableUsers)
      setMe(currentUser)
      await loadWorkspace()
    } catch (initialError) {
      setError(errorMessage(initialError))
      setLoadingWorkspace(false)
    }
  }

  async function loadWorkspace(preferredId?: string) {
    const requestId = ++workspaceRequest.current
    setLoadingWorkspace(true)
    setError('')
    try {
      const workspace = await api.workspace()
      if (requestId !== workspaceRequest.current) return
      setItems(workspace.items)

      const nextId =
        (preferredId && workspace.items.some((item) => item.id === preferredId)
          ? preferredId
          : defaultSelection(workspace.items)) ?? null
      setSelectedId(nextId)
      detailRequest.current += 1
      setDetail(null)
      if (nextId) await loadDetail(nextId)
    } catch (loadError) {
      if (requestId !== workspaceRequest.current) return
      setError(errorMessage(loadError))
      setItems([])
      setSelectedId(null)
      setDetail(null)
    } finally {
      if (requestId === workspaceRequest.current) setLoadingWorkspace(false)
    }
  }

  async function refreshWorkspace() {
    const requestId = ++workspaceRequest.current
    setLoadingWorkspace(true)
    try {
      const workspace = await api.workspace()
      if (requestId !== workspaceRequest.current) return
      setItems(workspace.items)
    } finally {
      if (requestId === workspaceRequest.current) setLoadingWorkspace(false)
    }
  }

  async function loadDetail(contentId: string) {
    const requestId = ++detailRequest.current
    setLoadingDetail(true)
    try {
      const nextDetail = await api.detail(contentId)
      if (requestId === detailRequest.current) setDetail(nextDetail)
    } catch (detailError) {
      if (requestId === detailRequest.current) {
        setError(errorMessage(detailError))
        setDetail(null)
      }
    } finally {
      if (requestId === detailRequest.current) setLoadingDetail(false)
    }
  }

  async function changeUser(userId: string) {
    setBusy(true)
    setError('')
    workspaceRequest.current += 1
    detailRequest.current += 1
    setItems([])
    setSelectedId(null)
    setDetail(null)
    setAdminOpen(false)
    setAdminUsers([])
    resetFilters()
    try {
      const currentUser = await api.switchUser(userId)
      setMe(currentUser)
      await loadWorkspace()
    } catch (switchError) {
      setError(errorMessage(switchError))
      setLoadingWorkspace(false)
    } finally {
      setBusy(false)
    }
  }

  function resetFilters() {
    setQuery('')
    setStatusFilter('ALL')
    setRiskFilter('ALL')
  }

  function openContent(contentId: string) {
    if (contentId === selectedId && detail) return
    setSelectedId(contentId)
    setDetail(null)
    setError('')
    void loadDetail(contentId)
  }

  async function saveContent(input: ContentInput) {
    setBusy(true)
    setError('')
    try {
      const saved =
        editor === 'edit' && detail
          ? await api.edit(detail.content.id, input, detail.content.version)
          : await api.create(input)
      setEditor(null)
      setSelectedId(saved.content.id)
      setDetail(saved)
      await refreshWorkspace()
    } catch (saveError) {
      setError(errorMessage(saveError))
      throw saveError
    } finally {
      setBusy(false)
    }
  }

  async function submitCurrent() {
    if (!detail) return
    setBusy(true)
    setError('')
    try {
      const updated = await api.submit(detail.content.id, detail.content.version)
      setDetail(updated)
      await refreshWorkspace()
    } catch (submitError) {
      setError(errorMessage(submitError))
    } finally {
      setBusy(false)
    }
  }

  async function decideCurrent(decision: DecisionType, comment: string) {
    const round = detail?.history[0]
    if (!round) return
    setBusy(true)
    setError('')
    try {
      const updated = await api.decide(round.id, decision, comment)
      setDetail(updated)
      await refreshWorkspace()
    } catch (decisionError) {
      setError(errorMessage(decisionError))
      throw decisionError
    } finally {
      setBusy(false)
    }
  }

  async function loadAdminUsers() {
    setLoadingAdmin(true)
    setError('')
    try {
      setAdminUsers(await api.adminUsers())
    } catch (adminError) {
      setError(errorMessage(adminError))
    } finally {
      setLoadingAdmin(false)
    }
  }

  function openAdmin() {
    setAdminOpen(true)
    void loadAdminUsers()
  }

  async function createUser(input: AdminUserInput) {
    setBusy(true)
    setError('')
    try {
      await api.createUser(input)
      const [availableUsers, managedUsers] = await Promise.all([
        api.users(),
        api.adminUsers(),
      ])
      setUsers(availableUsers)
      setAdminUsers(managedUsers)
    } catch (createError) {
      setError(errorMessage(createError))
      throw createError
    } finally {
      setBusy(false)
    }
  }

  async function updateUser(userId: string, input: AdminUserInput) {
    setBusy(true)
    setError('')
    try {
      await api.updateUser(userId, input)
      const [availableUsers, currentUser] = await Promise.all([api.users(), api.me()])
      setUsers(availableUsers)
      setMe(currentUser)
      if (currentUser.roles.includes('ADMIN')) {
        setAdminUsers(await api.adminUsers())
      } else {
        setAdminOpen(false)
        setAdminUsers([])
      }
      await loadWorkspace(selectedId ?? undefined)
    } catch (updateError) {
      setError(errorMessage(updateError))
      throw updateError
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void initialize()
  }, [])

  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase('zh-CN')
  const filteredItems = items.filter((item) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      item.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery) ||
      item.author.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
    const matchesStatus = statusFilter === 'ALL' || item.status === statusFilter
    const matchesRisk = riskFilter === 'ALL' || item.risk === riskFilter
    return matchesQuery && matchesStatus && matchesRisk
  })
  const visibleQueues = queueDefinitions.filter(({ key }) => {
    if (key === 'MINE') return me?.roles.includes('SUBMITTER')
    if (key === 'ADMIN') return me?.roles.includes('ADMIN')
    return me?.roles.includes('REVIEWER')
  })
  const hasFilters = query.trim().length > 0 || statusFilter !== 'ALL' || riskFilter !== 'ALL'
  const metrics = [
    {
      label: '待我审核',
      value: items.filter((item) => item.queues.includes('PENDING_REVIEW')).length,
      tone: 'attention',
    },
    {
      label: '审核中',
      value: items.filter((item) => item.status === 'IN_REVIEW').length,
      tone: 'info',
    },
    {
      label: '已拒绝',
      value: items.filter((item) => item.status === 'REJECTED').length,
      tone: 'danger',
    },
    { label: '相关请求', value: items.length, tone: 'neutral' },
  ]

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <ShieldCheck aria-hidden="true" />
          </span>
          <div>
            <strong>ReviewFlow</strong>
            <span>统一内容审核工作台</span>
          </div>
        </div>

        {me && (
          <div className="identity-area">
            <a className="docs-entry" href={`${import.meta.env.BASE_URL}docs/`}>
              <BookOpen aria-hidden="true" />
              <span>文档</span>
            </a>
            {me.roles.includes('ADMIN') && (
              <button
                type="button"
                className="admin-entry"
                disabled={busy}
                onClick={openAdmin}
              >
                <UsersRound aria-hidden="true" />
                用户与角色
              </button>
            )}
            <div className="role-list" aria-label="当前角色">
              {me.roles.map((role) => (
                <span key={role}>{role}</span>
              ))}
            </div>
            <label className="user-switch">
              <span>服务端当前用户</span>
              <select
                value={me.id}
                disabled={busy}
                onChange={(event) => void changeUser(event.target.value)}
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </header>

      <section className="overview-bar" aria-labelledby="workspace-title">
        <div className="overview-copy">
          <p className="eyebrow">END-TO-END WORKSPACE</p>
          <h1 id="workspace-title">审核请求全景</h1>
          <p>在同一页面处理待办、跟踪进度并追溯每一轮提交快照。</p>
        </div>
        <div className="overview-metrics" aria-label="工作台概览">
          {metrics.map((metric) => (
            <span key={metric.label} className={`metric-${metric.tone}`}>
              <strong>{metric.value}</strong>
              <small>{metric.label}</small>
            </span>
          ))}
        </div>
      </section>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="icon-button"
            title="关闭"
            aria-label="关闭"
            onClick={() => setError('')}
          >
            ×
          </button>
        </div>
      )}

      <main className="workspace">
        <aside className="list-pane" aria-label="请求队列">
          <header className="list-header">
            <div>
              <p className="eyebrow">FLOW QUEUES</p>
              <h2>全部流转</h2>
            </div>
            <div className="list-tools">
              <span
                className={`item-count ${filteredItems.length !== items.length ? 'filtered' : ''}`}
                title="当前结果 / 相关请求"
              >
                {filteredItems.length === items.length
                  ? items.length
                  : `${filteredItems.length}/${items.length}`}
              </span>
              <button
                type="button"
                className="icon-button"
                title="刷新工作台"
                aria-label="刷新工作台"
                disabled={loadingWorkspace || busy}
                onClick={() => void loadWorkspace(selectedId ?? undefined)}
              >
                <RefreshCw className={loadingWorkspace ? 'spinning' : ''} aria-hidden="true" />
              </button>
              {me?.roles.includes('SUBMITTER') && (
                <button
                  type="button"
                  className="icon-button primary-icon"
                  title="创建内容"
                  aria-label="创建内容"
                  disabled={busy}
                  onClick={() => setEditor('create')}
                >
                  <FilePlus2 aria-hidden="true" />
                </button>
              )}
            </div>
          </header>

          <div className="filter-toolbar">
            <label className="search-field">
              <span className="sr-only">搜索标题或作者</span>
              <Search aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder="搜索标题或作者"
                onChange={(event) =>
                  applyFilters(event.target.value, statusFilter, riskFilter)
                }
              />
            </label>
            <div className="filter-options">
              <label className="filter-select">
                <span>状态</span>
                <select
                  value={statusFilter}
                  onChange={(event) =>
                    applyFilters(query, event.target.value as StatusFilter, riskFilter)
                  }
                >
                  <option value="ALL">全部状态</option>
                  <option value="DRAFT">草稿</option>
                  <option value="IN_REVIEW">审核中</option>
                  <option value="APPROVED">已通过</option>
                  <option value="REJECTED">已拒绝</option>
                </select>
              </label>
              <label className="filter-select">
                <span>风险</span>
                <select
                  value={riskFilter}
                  onChange={(event) =>
                    applyFilters(query, statusFilter, event.target.value as RiskFilter)
                  }
                >
                  <option value="ALL">全部风险</option>
                  <option value="LOW">LOW</option>
                  <option value="HIGH">HIGH</option>
                </select>
              </label>
              {hasFilters && (
                <button
                  type="button"
                  className="icon-button clear-filters"
                  title="清除筛选"
                  aria-label="清除筛选"
                  onClick={resetFilters}
                >
                  <X aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {loadingWorkspace && items.length === 0 ? (
            <div className="loading-state">
              <LoaderCircle aria-hidden="true" />
              加载工作台…
            </div>
          ) : (
            <div className="queue-board">
              {visibleQueues.map((queue) => {
                const QueueIcon = queue.icon
                const queueItems = filteredItems.filter((item) =>
                  item.queues.includes(queue.key),
                )
                const total = items.filter((item) => item.queues.includes(queue.key)).length
                return (
                  <section className="queue-section" key={queue.key}>
                    <header className="queue-section-header">
                      <span className={`queue-icon queue-${queue.key.toLowerCase()}`}>
                        <QueueIcon aria-hidden="true" />
                      </span>
                      <span>
                        <strong>{queue.title}</strong>
                        <small>{queue.description}</small>
                      </span>
                      <b title="当前结果 / 队列总数">
                        {queueItems.length === total ? total : `${queueItems.length}/${total}`}
                      </b>
                    </header>
                    {queueItems.length === 0 ? (
                      <div className="queue-empty">
                        <Archive aria-hidden="true" />
                        <span>{total === 0 ? '当前队列为空' : '没有匹配筛选的请求'}</span>
                      </div>
                    ) : (
                      <div className="content-list">
                        {queueItems.map((item) => (
                          <button
                            type="button"
                            key={`${queue.key}-${item.id}`}
                            className={`content-list-item ${selectedId === item.id ? 'selected' : ''}`}
                            disabled={busy}
                            onClick={() => openContent(item.id)}
                          >
                            <span className="list-item-topline">
                              <span className={`risk-dot risk-${item.risk.toLowerCase()}`}>
                                {item.risk}
                              </span>
                              <span className={`status-text status-${item.status.toLowerCase()}`}>
                                {statusLabels[item.status]}
                              </span>
                            </span>
                            <strong>{item.title}</strong>
                            <span className="list-item-progress">
                              {item.currentRound ? (
                                <>
                                  R{item.currentRound.roundNo} ·{' '}
                                  {item.currentRound.approvalCount}/
                                  {item.currentRound.requiredApprovals} 票
                                  <span>· 共 {item.roundCount} 轮</span>
                                </>
                              ) : (
                                '尚未提交审核'
                              )}
                            </span>
                            <span className="list-item-meta">
                              <span>{item.author.name}</span>
                              <span className="list-item-date">
                                <Clock3 aria-hidden="true" />
                                {compactDateFormatter.format(new Date(item.updatedAt))}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </aside>

        <section className="detail-pane" aria-label="请求详情">
          {loadingDetail && !detail ? (
            <div className="loading-state">
              <LoaderCircle aria-hidden="true" />
              加载请求详情…
            </div>
          ) : detail ? (
            <ContentDetail
              key={`${detail.content.id}-${detail.content.version}`}
              detail={detail}
              busy={busy}
              onEdit={() => setEditor('edit')}
              onSubmit={submitCurrent}
              onDecision={decideCurrent}
            />
          ) : (
            <div className="empty-detail">
              <ShieldCheck aria-hidden="true" />
              <h2>选择一条审核请求</h2>
              <p>完整状态轨迹、当前进度、提交快照和每次审核决定会显示在这里。</p>
            </div>
          )}
        </section>
      </main>

      {editor && (
        <ContentEditor
          mode={editor}
          initial={
            editor === 'edit' && detail
              ? {
                  title: detail.content.title,
                  body: detail.content.body,
                  risk: detail.content.risk,
                }
              : undefined
          }
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={saveContent}
        />
      )}

      {adminOpen && me?.roles.includes('ADMIN') && (
        <AdminUserPanel
          users={adminUsers}
          currentUserId={me.id}
          loading={loadingAdmin}
          busy={busy}
          onClose={() => setAdminOpen(false)}
          onReload={loadAdminUsers}
          onCreate={createUser}
          onUpdate={updateUser}
        />
      )}
    </div>
  )
}

function defaultSelection(items: WorkspaceItem[]): string | undefined {
  return (
    items.find((item) => item.queues.includes('PENDING_REVIEW')) ??
    items.find((item) => item.queues.includes('MINE')) ??
    items[0]
  )?.id
}

export default App
