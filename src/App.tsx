import {
  Activity,
  BookOpen,
  CheckCircle2,
  ChevronsUpDown,
  CircleHelp,
  ClipboardCheck,
  FilePlus2,
  Files,
  Gauge,
  History,
  Inbox,
  LayoutDashboard,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from './api'
import './App.css'
import { AdminUserPanel } from './components/AdminUserPanel'
import { ContentDetail } from './components/ContentDetail'
import {
  ContentEditor,
  type ContentSaveIntent,
} from './components/ContentEditor'
import {
  OnboardingGuide,
  type GuideTarget,
} from './components/OnboardingGuide'
import {
  WorkspaceRequestList,
  type RiskFilter,
  type StatusFilter,
} from './components/WorkspaceRequestList'
import type {
  AdminUser,
  AdminUserInput,
  ContentDetail as ContentDetailData,
  ContentInput,
  DecisionType,
  User,
  WorkspaceItem,
  WorkspaceQueue,
  WorkspaceScope,
  WorkspaceSort,
} from './types'
import {
  formatRoleLabels,
  formatUserOption,
  isPresetUser,
} from './userPresentation'

interface ScopeDefinition {
  key: WorkspaceScope
  title: string
  shortTitle: string
  description: string
  icon: LucideIcon
}

interface ViewCriteria {
  scope: WorkspaceScope
  query: string
  status: StatusFilter
  risk: RiskFilter
  sort: WorkspaceSort
}

interface Notice {
  id: number
  tone: 'success' | 'error'
  message: string
}

const queueDefinitions: Array<ScopeDefinition & { key: WorkspaceQueue }> = [
  {
    key: 'PENDING_REVIEW',
    title: '待我审核',
    shortTitle: '待我审核',
    description: '当前轮次等待你的审核决定',
    icon: Inbox,
  },
  {
    key: 'MINE',
    title: '我的提交',
    shortTitle: '我的提交',
    description: '我创建的全部内容请求',
    icon: Files,
  },
  {
    key: 'REVIEWED',
    title: '我已参与',
    shortTitle: '已参与',
    description: '我曾做出审核决定的请求',
    icon: History,
  },
  {
    key: 'ADMIN',
    title: '全部请求',
    shortTitle: '全部请求',
    description: '管理员可见的全量审核请求',
    icon: ClipboardCheck,
  },
]

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
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
  const [guideOpen, setGuideOpen] = useState(false)
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([])
  const [loadingAdmin, setLoadingAdmin] = useState(false)
  const [loadingWorkspace, setLoadingWorkspace] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null)
  const [scope, setScope] = useState<WorkspaceScope>('ALL')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('ALL')
  const [sort, setSort] = useState<WorkspaceSort>('UPDATED_DESC')
  const initialized = useRef(false)
  const workspaceRequest = useRef(0)
  const detailRequest = useRef(0)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticeSequence = useRef(0)

  const criteria: ViewCriteria = {
    scope,
    query,
    status: statusFilter,
    risk: riskFilter,
    sort,
  }

  async function loadWorkspace(options: {
    preferredId?: string
    knownDetail?: ContentDetailData
    criteria?: Partial<ViewCriteria>
  } = {}) {
    const requestId = ++workspaceRequest.current
    const nextCriteria = { ...criteria, ...options.criteria }
    setLoadingWorkspace(true)
    setError('')
    try {
      const workspace = await api.workspace()
      if (requestId !== workspaceRequest.current) return

      setItems(workspace.items)
      setLastSyncedAt(new Date())
      const candidates = selectWorkspaceItems(workspace.items, nextCriteria)
      const nextId =
        (options.preferredId &&
        candidates.some((item) => item.id === options.preferredId)
          ? options.preferredId
          : candidates[0]?.id) ?? null
      setSelectedId(nextId)

      if (!nextId) {
        detailRequest.current += 1
        setDetail(null)
      } else if (
        options.knownDetail &&
        options.knownDetail.content.id === nextId
      ) {
        detailRequest.current += 1
        setDetail(options.knownDetail)
      } else {
        setDetail(null)
        await loadDetail(nextId)
      }
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

  async function changeUser(
    userId: string,
    requestedCriteria: Partial<ViewCriteria> = {},
  ) {
    const resetCriteria: ViewCriteria = {
      scope: 'ALL',
      query: '',
      status: 'ALL',
      risk: 'ALL',
      sort: 'UPDATED_DESC',
      ...requestedCriteria,
    }
    setBusy(true)
    setError('')
    workspaceRequest.current += 1
    detailRequest.current += 1
    setItems([])
    setSelectedId(null)
    setDetail(null)
    setAdminOpen(false)
    setAdminUsers([])
    setScope(resetCriteria.scope)
    setQuery(resetCriteria.query)
    setStatusFilter(resetCriteria.status)
    setRiskFilter(resetCriteria.risk)
    setSort(resetCriteria.sort)
    try {
      const currentUser = await api.switchUser(userId)
      setMe(currentUser)
      await loadWorkspace({ criteria: resetCriteria })
      showNotice(`已切换为 ${currentUser.name}`)
    } catch (switchError) {
      setError(errorMessage(switchError))
      setLoadingWorkspace(false)
    } finally {
      setBusy(false)
    }
  }

  function applyView(next: Partial<ViewCriteria>) {
    const nextCriteria = { ...criteria, ...next }
    if (next.scope !== undefined) setScope(next.scope)
    if (next.query !== undefined) setQuery(next.query)
    if (next.status !== undefined) setStatusFilter(next.status)
    if (next.risk !== undefined) setRiskFilter(next.risk)
    if (next.sort !== undefined) setSort(next.sort)

    const candidates = selectWorkspaceItems(items, nextCriteria)
    if (selectedId && candidates.some((item) => item.id === selectedId)) return

    const nextId = candidates[0]?.id ?? null
    setSelectedId(nextId)
    if (nextId) {
      setDetail(null)
      void loadDetail(nextId)
    } else {
      detailRequest.current += 1
      setDetail(null)
    }
  }

  function resetFilters() {
    applyView({ query: '', status: 'ALL', risk: 'ALL' })
  }

  function openContent(contentId: string) {
    if (contentId === selectedId && detail) return
    setSelectedId(contentId)
    setDetail(null)
    setError('')
    void loadDetail(contentId)
  }

  async function saveContent(input: ContentInput, intent: ContentSaveIntent) {
    setBusy(true)
    setError('')
    try {
      const isEdit = editor === 'edit' && detail
      const saved = isEdit
        ? await api.edit(detail.content.id, input, detail.content.version)
        : await api.create(input)
      let result = saved
      if (intent === 'SUBMIT') {
        try {
          result = await api.submit(saved.content.id, saved.content.version)
        } catch (submitError) {
          setEditor(null)
          setScope('ALL')
          setQuery('')
          setStatusFilter('ALL')
          setRiskFilter('ALL')
          await loadWorkspace({
            preferredId: saved.content.id,
            knownDetail: saved,
            criteria: {
              scope: 'ALL',
              query: '',
              status: 'ALL',
              risk: 'ALL',
            },
          })
          setError(`内容已保存，但提交审核失败：${errorMessage(submitError)}`)
          return
        }
      }
      setEditor(null)
      setScope('ALL')
      setQuery('')
      setStatusFilter('ALL')
      setRiskFilter('ALL')
      await loadWorkspace({
        preferredId: result.content.id,
        knownDetail: result,
        criteria: {
          scope: 'ALL',
          query: '',
          status: 'ALL',
          risk: 'ALL',
        },
      })
      showNotice(
        intent === 'SUBMIT'
          ? isEdit
            ? '修改已保存并提交审核'
            : '内容已创建并提交审核'
          : isEdit
            ? '内容变更已保存'
            : '草稿已暂存',
      )
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
      await loadWorkspace({
        preferredId: updated.content.id,
        knownDetail: updated,
      })
      showNotice(`已创建第 ${updated.history[0]?.roundNo ?? 1} 轮审核`)
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
      await loadWorkspace({
        preferredId: updated.content.id,
        knownDetail: updated,
      })
      showNotice(decision === 'APPROVE' ? '审核决定已通过' : '已拒绝当前审核轮次')
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

  async function startGuideStep(target: GuideTarget) {
    setGuideOpen(false)
    if (
      target.action === 'SUBMIT' &&
      me?.id === target.userId &&
      detail?.content.status === 'DRAFT'
    ) {
      showNotice('已定位当前草稿，请点击“提交审核”')
      return
    }
    await changeUser(target.userId, {
      scope: target.scope,
      query: target.query,
      status: target.status,
      risk: target.risk,
    })
    if (target.action === 'CREATE') setEditor('create')
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
      showNotice(`用户 ${input.name.trim()} 已创建`)
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
      const nextScope = isScopeAvailable(currentUser, scope) ? scope : 'ALL'
      if (nextScope !== scope) setScope(nextScope)
      await loadWorkspace({
        preferredId: selectedId ?? undefined,
        criteria: { scope: nextScope },
      })
      showNotice(`${input.name.trim()} 的权限已更新`)
    } catch (updateError) {
      setError(errorMessage(updateError))
      throw updateError
    } finally {
      setBusy(false)
    }
  }

  function showNotice(message: string, tone: Notice['tone'] = 'success') {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeSequence.current += 1
    setNotice({ id: noticeSequence.current, tone, message })
    noticeTimer.current = setTimeout(() => setNotice(null), 4_000)
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    const initializeWorkspace = async () => {
      const requestId = ++workspaceRequest.current
      setLoadingWorkspace(true)
      setError('')
      try {
        const [availableUsers, currentUser, workspace] = await Promise.all([
          api.users(),
          api.me(),
          api.workspace(),
        ])
        if (requestId !== workspaceRequest.current) return
        setUsers(availableUsers)
        setMe(currentUser)
        setItems(workspace.items)
        setLastSyncedAt(new Date())

        const initialCriteria: ViewCriteria = {
          scope: 'ALL',
          query: '',
          status: 'ALL',
          risk: 'ALL',
          sort: 'UPDATED_DESC',
        }
        const nextId =
          selectWorkspaceItems(workspace.items, initialCriteria)[0]?.id ?? null
        setSelectedId(nextId)
        if (nextId) {
          const nextDetail = await api.detail(nextId)
          if (requestId === workspaceRequest.current) setDetail(nextDetail)
        }
      } catch (initialError) {
        if (requestId !== workspaceRequest.current) return
        setError(errorMessage(initialError))
        setItems([])
        setSelectedId(null)
        setDetail(null)
      } finally {
        if (requestId === workspaceRequest.current) setLoadingWorkspace(false)
      }
    }
    void initializeWorkspace()
  }, [])

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    [],
  )

  const visibleQueueDefinitions = queueDefinitions.filter(({ key }) => {
    if (key === 'MINE') return me?.roles.includes('SUBMITTER')
    if (key === 'ADMIN') {
      return me?.roles.includes('ADMIN') && me.roles.length > 1
    }
    return me?.roles.includes('REVIEWER')
  })
  const allScope: ScopeDefinition = {
    key: 'ALL',
    title: me?.roles.length === 1 && me.roles.includes('ADMIN') ? '全部请求' : '工作台概览',
    shortTitle: me?.roles.length === 1 && me.roles.includes('ADMIN') ? '全部请求' : '工作台',
    description: '当前身份可见的全部相关请求',
    icon: LayoutDashboard,
  }
  const scopeDefinitions = [allScope, ...visibleQueueDefinitions]
  const activeScope =
    scopeDefinitions.find((definition) => definition.key === scope) ?? allScope
  const scopeItems = selectWorkspaceItems(items, {
    ...criteria,
    query: '',
    status: 'ALL',
    risk: 'ALL',
  })
  const visibleItems = selectWorkspaceItems(items, criteria)

  const pendingCount = items.filter((item) =>
    item.queues.includes('PENDING_REVIEW'),
  ).length
  const canReview = me?.roles.includes('REVIEWER') ?? false
  const inReviewCount = items.filter((item) => item.status === 'IN_REVIEW').length
  const highRiskCount = items.filter(
    (item) => item.status === 'IN_REVIEW' && item.risk === 'HIGH',
  ).length
  const rejectedCount = items.filter((item) => item.status === 'REJECTED').length
  const emptyTitle =
    scope === 'PENDING_REVIEW' ? '当前没有可由你审核的请求' : '当前视图暂无请求'
  const emptyDescription =
    scope === 'PENDING_REVIEW'
      ? '作者不能审核自己的内容；可切换 Bob 或 Chen 查看共享待审池。'
      : '新的请求或符合条件的数据会显示在这里。'

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">
            <ShieldCheck aria-hidden="true" />
          </span>
          <div>
            <strong>ReviewFlow</strong>
            <span>Content Operations</span>
          </div>
        </div>

        <div className="sidebar-context">
          <span>当前空间</span>
          <strong>内容治理中心</strong>
          <small>内部审核 · 生产环境</small>
        </div>

        <nav className="app-nav" aria-label="审核工作台导航">
          <span className="nav-label">工作台</span>
          {scopeDefinitions.map((definition) => {
            const NavIcon = definition.icon
            const count =
              definition.key === 'ALL'
                ? items.length
                : items.filter((item) =>
                    item.queues.includes(definition.key as WorkspaceQueue),
                  ).length
            return (
              <button
                type="button"
                key={definition.key}
                className={scope === definition.key ? 'active' : ''}
                onClick={() => applyView({ scope: definition.key })}
              >
                <NavIcon aria-hidden="true" />
                <span>{definition.shortTitle}</span>
                <b>{count}</b>
              </button>
            )
          })}
        </nav>

        <nav className="app-nav status-nav" aria-label="状态快捷视图">
          <span className="nav-label">状态视图</span>
          <button
            type="button"
            className={
              scope === 'ALL' &&
              statusFilter === 'IN_REVIEW' &&
              riskFilter === 'ALL'
                ? 'active'
                : ''
            }
            onClick={() =>
              applyView({ scope: 'ALL', status: 'IN_REVIEW', risk: 'ALL' })
            }
          >
            <Activity aria-hidden="true" />
            <span>审核中</span>
            <b>{inReviewCount}</b>
          </button>
          <button
            type="button"
            className={
              scope === 'ALL' &&
              statusFilter === 'IN_REVIEW' &&
              riskFilter === 'HIGH'
                ? 'active'
                : ''
            }
            onClick={() =>
              applyView({ scope: 'ALL', status: 'IN_REVIEW', risk: 'HIGH' })
            }
          >
            <TriangleAlert aria-hidden="true" />
            <span>高风险待审</span>
            <b>{highRiskCount}</b>
          </button>
          <button
            type="button"
            className={
              scope === 'ALL' &&
              statusFilter === 'REJECTED' &&
              riskFilter === 'ALL'
                ? 'active'
                : ''
            }
            onClick={() =>
              applyView({ scope: 'ALL', status: 'REJECTED', risk: 'ALL' })
            }
          >
            <RotateCcw aria-hidden="true" />
            <span>已拒绝可重提</span>
            <b>{rejectedCount}</b>
          </button>
        </nav>

        <nav className="app-nav secondary-nav" aria-label="系统导航">
          <span className="nav-label">系统</span>
          <button type="button" onClick={() => setGuideOpen(true)}>
            <CircleHelp aria-hidden="true" />
            <span>新手引导</span>
            <b>6 步</b>
          </button>
          {me?.roles.includes('ADMIN') && (
            <button type="button" onClick={openAdmin}>
              <UsersRound aria-hidden="true" />
              <span>用户与权限</span>
            </button>
          )}
          <a href={`${import.meta.env.BASE_URL}docs/`}>
            <BookOpen aria-hidden="true" />
            <span>系统文档</span>
          </a>
        </nav>

        {me && (
          <div className="sidebar-profile">
            <span className="profile-avatar" aria-hidden="true">
              {me.name.slice(0, 1).toLocaleUpperCase()}
            </span>
            <div className="profile-copy">
              <span>当前操作人</span>
              <strong>{me.name}</strong>
              <small>
                {formatRoleLabels(me.roles)} ·{' '}
                {isPresetUser(me.id) ? '预置账号' : '自定义账号'}
              </small>
            </div>
            <label className="profile-switch" title="切换当前操作人">
              <ChevronsUpDown aria-hidden="true" />
              <span className="sr-only">切换当前用户</span>
              <select
                value={me.id}
                disabled={busy}
                aria-label="切换当前用户"
                onChange={(event) => void changeUser(event.target.value)}
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {formatUserOption(user)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumbs" aria-label="面包屑">
            <span>内容治理</span>
            <b>/</b>
            <strong>审核工作台</strong>
          </div>
          <div className="topbar-tools">
            <span className="sync-status">
              <i />
              {lastSyncedAt
                ? `已同步 ${timeFormatter.format(lastSyncedAt)}`
                : '正在连接'}
            </span>
            <button
              type="button"
              className="icon-button"
              title="刷新全部数据"
              aria-label="刷新全部数据"
              disabled={loadingWorkspace || busy}
              onClick={() =>
                void loadWorkspace({ preferredId: selectedId ?? undefined })
              }
            >
              <RefreshCw
                className={loadingWorkspace ? 'spinning' : ''}
                aria-hidden="true"
              />
            </button>
            <div className="role-list" aria-label="当前角色">
              {me?.roles.map((role) => <span key={role}>{role}</span>)}
            </div>
          </div>
        </header>

        <section className="page-header" aria-labelledby="workspace-title">
          <div className="page-title-row">
            <div>
              <span className="section-kicker">REVIEW OPERATIONS</span>
              <h1 id="workspace-title">审核工作台</h1>
              <p>集中处理审核待办、跟踪当前进度并追溯每一轮内容快照。</p>
            </div>
            {me?.roles.includes('SUBMITTER') && (
              <button
                type="button"
                className="button primary create-button"
                disabled={busy}
                onClick={() => setEditor('create')}
              >
                <FilePlus2 aria-hidden="true" />
                新建内容
              </button>
            )}
          </div>

          <div className="metric-grid" aria-label="审核运营概览">
            <button
              type="button"
              className="metric-card metric-pending"
              onClick={() =>
                canReview
                  ? applyView({
                      scope: 'PENDING_REVIEW',
                      status: 'ALL',
                      risk: 'ALL',
                    })
                  : applyView({
                      scope: 'ALL',
                      status: 'IN_REVIEW',
                      risk: 'ALL',
                    })
              }
            >
              <span className="metric-icon"><Inbox aria-hidden="true" /></span>
              <span>
                <small>{canReview ? '待我处理' : '待审核总量'}</small>
                <strong>{canReview ? pendingCount : inReviewCount}</strong>
              </span>
              <em>{canReview ? '需要审核决定' : '仅查看，不能审核'}</em>
            </button>
            <button
              type="button"
              className="metric-card metric-reviewing"
              onClick={() =>
                applyView({ scope: 'ALL', status: 'IN_REVIEW', risk: 'ALL' })
              }
            >
              <span className="metric-icon"><Activity aria-hidden="true" /></span>
              <span><small>审核中</small><strong>{inReviewCount}</strong></span>
              <em>开放轮次</em>
            </button>
            <button
              type="button"
              className="metric-card metric-risk"
              onClick={() =>
                applyView({ scope: 'ALL', status: 'IN_REVIEW', risk: 'HIGH' })
              }
            >
              <span className="metric-icon"><TriangleAlert aria-hidden="true" /></span>
              <span><small>高风险待审</small><strong>{highRiskCount}</strong></span>
              <em>需要双人通过</em>
            </button>
            <button
              type="button"
              className="metric-card metric-rejected"
              onClick={() =>
                applyView({ scope: 'ALL', status: 'REJECTED', risk: 'ALL' })
              }
            >
              <span className="metric-icon"><Gauge aria-hidden="true" /></span>
              <span><small>已拒绝</small><strong>{rejectedCount}</strong></span>
              <em>可修改重提</em>
            </button>
          </div>
        </section>

        <main className="workspace">
          <WorkspaceRequestList
            title={activeScope.title}
            description={activeScope.description}
            items={visibleItems}
            totalCount={scopeItems.length}
            selectedId={selectedId}
            query={query}
            statusFilter={statusFilter}
            riskFilter={riskFilter}
            sort={sort}
            loading={loadingWorkspace}
            busy={busy}
            emptyTitle={emptyTitle}
            emptyDescription={emptyDescription}
            onQueryChange={(nextQuery) => applyView({ query: nextQuery })}
            onFiltersChange={(status, risk) => applyView({ status, risk })}
            onSortChange={(nextSort) => applyView({ sort: nextSort })}
            onResetFilters={resetFilters}
            onSelect={openContent}
            onRefresh={() =>
              void loadWorkspace({ preferredId: selectedId ?? undefined })
            }
          />

          <section className="detail-pane" aria-label="请求详情">
            {loadingDetail && !detail ? (
              <div className="detail-loading">
                <span />
                <span />
                <span />
                <span />
              </div>
            ) : detail ? (
              <ContentDetail
                key={`${detail.content.id}-${detail.content.version}`}
                detail={detail}
                busy={busy}
                onEdit={() => setEditor('edit')}
                onSubmit={submitCurrent}
                onDecision={decideCurrent}
                onNotify={showNotice}
              />
            ) : (
              <div className="empty-detail">
                <span className="empty-detail-icon">
                  <ShieldCheck aria-hidden="true" />
                </span>
                <span className="section-kicker">REQUEST INSPECTOR</span>
                <h2>选择一条审核请求</h2>
                <p>内容、轮次进度、审核操作和完整审计记录会显示在这里。</p>
              </div>
            )}
          </section>
        </main>
      </div>

      <div className="toast-stack" aria-live="polite">
        {error && (
          <div className="toast toast-error" role="alert">
            <TriangleAlert aria-hidden="true" />
            <span>
              <strong>操作未完成</strong>
              <small>{error}</small>
            </span>
            <button type="button" aria-label="关闭错误" onClick={() => setError('')}>
              <X aria-hidden="true" />
            </button>
          </div>
        )}
        {notice && (
          <div className={`toast toast-${notice.tone}`} key={notice.id}>
            {notice.tone === 'error' ? (
              <TriangleAlert aria-hidden="true" />
            ) : (
              <CheckCircle2 aria-hidden="true" />
            )}
            <span>
              <strong>操作成功</strong>
              <small>{notice.message}</small>
            </span>
            <button type="button" aria-label="关闭通知" onClick={() => setNotice(null)}>
              <X aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {guideOpen && (
        <OnboardingGuide
          busy={busy}
          onClose={() => setGuideOpen(false)}
          onStart={startGuideStep}
        />
      )}

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

function selectWorkspaceItems(
  items: WorkspaceItem[],
  criteria: ViewCriteria,
): WorkspaceItem[] {
  const normalizedQuery = criteria.query.trim().toLocaleLowerCase('zh-CN')
  return items
    .filter((item) => {
      const matchesScope =
        criteria.scope === 'ALL' || item.queues.includes(criteria.scope)
      const matchesQuery =
        normalizedQuery.length === 0 ||
        item.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery) ||
        item.author.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
      const matchesStatus =
        criteria.status === 'ALL' || item.status === criteria.status
      const matchesRisk =
        criteria.risk === 'ALL' || item.risk === criteria.risk
      return matchesScope && matchesQuery && matchesStatus && matchesRisk
    })
    .sort((left, right) => compareWorkspaceItems(left, right, criteria.sort))
}

function compareWorkspaceItems(
  left: WorkspaceItem,
  right: WorkspaceItem,
  sort: WorkspaceSort,
): number {
  if (sort === 'TITLE_ASC') {
    return left.title.localeCompare(right.title, 'zh-CN')
  }
  if (sort === 'UPDATED_ASC') {
    return (
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.id.localeCompare(right.id)
    )
  }
  if (sort === 'UPDATED_DESC') {
    return (
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
    )
  }
  return (
    workspacePriority(left) - workspacePriority(right) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  )
}

function workspacePriority(item: WorkspaceItem): number {
  if (item.queues.includes('PENDING_REVIEW')) return item.risk === 'HIGH' ? 0 : 1
  if (item.status === 'IN_REVIEW') return item.risk === 'HIGH' ? 2 : 3
  if (item.status === 'REJECTED') return 4
  if (item.status === 'DRAFT') return 5
  return 6
}

function isScopeAvailable(user: User, scope: WorkspaceScope): boolean {
  if (scope === 'ALL') return true
  if (scope === 'MINE') return user.roles.includes('SUBMITTER')
  if (scope === 'ADMIN') return user.roles.includes('ADMIN')
  return user.roles.includes('REVIEWER')
}

export default App
