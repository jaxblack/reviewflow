import {
  ClipboardCheck,
  Files,
  FilePlus2,
  Inbox,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, errorMessage } from './api'
import './App.css'
import { ContentDetail } from './components/ContentDetail'
import { ContentEditor } from './components/ContentEditor'
import type {
  ContentDetail as ContentDetailData,
  ContentInput,
  ContentSummary,
  DecisionType,
  User,
  ViewKey,
} from './types'

const statusLabels = {
  DRAFT: '草稿',
  IN_REVIEW: '审核中',
  APPROVED: '已通过',
  REJECTED: '已拒绝',
} as const

const viewLabels: Record<ViewKey, string> = {
  mine: '我的内容',
  pending: '待我审核',
  all: '全部内容',
}

function App() {
  const [users, setUsers] = useState<User[]>([])
  const [me, setMe] = useState<User | null>(null)
  const [view, setView] = useState<ViewKey>('mine')
  const [items, setItems] = useState<ContentSummary[]>([])
  const [detail, setDetail] = useState<ContentDetailData | null>(null)
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void initialize()
  }, [])

  async function initialize() {
    setLoading(true)
    try {
      const [availableUsers, currentUser] = await Promise.all([api.users(), api.me()])
      const initialView = firstView(currentUser)
      setUsers(availableUsers)
      setMe(currentUser)
      setView(initialView)
      await loadWorkspace(initialView)
    } catch (initialError) {
      setError(errorMessage(initialError))
    } finally {
      setLoading(false)
    }
  }

  async function fetchItems(nextView: ViewKey): Promise<ContentSummary[]> {
    if (nextView === 'mine') return api.listMine()
    if (nextView === 'pending') return api.listPending()
    return api.listAll()
  }

  async function loadWorkspace(nextView: ViewKey, preferredId?: string) {
    setLoading(true)
    setError('')
    try {
      const nextItems = await fetchItems(nextView)
      setItems(nextItems)
      const nextId = preferredId ?? nextItems[0]?.id
      setDetail(nextId ? await api.detail(nextId) : null)
    } catch (loadError) {
      setError(errorMessage(loadError))
      setItems([])
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }

  async function changeUser(userId: string) {
    setBusy(true)
    setError('')
    try {
      const currentUser = await api.switchUser(userId)
      const nextView = firstView(currentUser)
      setMe(currentUser)
      setView(nextView)
      await loadWorkspace(nextView)
    } catch (switchError) {
      setError(errorMessage(switchError))
    } finally {
      setBusy(false)
    }
  }

  async function openContent(contentId: string) {
    setLoading(true)
    setError('')
    try {
      setDetail(await api.detail(contentId))
    } catch (detailError) {
      setError(errorMessage(detailError))
    } finally {
      setLoading(false)
    }
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
      setView('mine')
      await loadWorkspace('mine', saved.content.id)
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
      setItems(await fetchItems(view))
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
      setItems(await fetchItems(view))
    } catch (decisionError) {
      setError(errorMessage(decisionError))
      throw decisionError
    } finally {
      setBusy(false)
    }
  }

  const views = me ? availableViews(me) : []

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <ShieldCheck aria-hidden="true" />
          </span>
          <div>
            <strong>ReviewFlow</strong>
            <span>内容审核台</span>
          </div>
        </div>

        {me && (
          <div className="identity-area">
            <div className="role-list" aria-label="当前角色">
              {me.roles.map((role) => (
                <span key={role}>{role}</span>
              ))}
            </div>
            <label className="user-switch">
              <span>当前用户</span>
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

      <nav className="view-tabs" aria-label="主要页面">
        {views.map((item) => (
          <button
            type="button"
            key={item}
            className={view === item ? 'active' : ''}
            onClick={() => {
              setView(item)
              void loadWorkspace(item)
            }}
          >
            {item === 'mine' && <Files aria-hidden="true" />}
            {item === 'pending' && <Inbox aria-hidden="true" />}
            {item === 'all' && <ClipboardCheck aria-hidden="true" />}
            {viewLabels[item]}
          </button>
        ))}
      </nav>

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
        <aside className="list-pane">
          <header className="list-header">
            <div>
              <p className="eyebrow">QUEUE</p>
              <h1>{viewLabels[view]}</h1>
            </div>
            <div className="list-tools">
              <span className="item-count">{items.length}</span>
              <button
                type="button"
                className="icon-button"
                title="刷新"
                aria-label="刷新"
                disabled={loading}
                onClick={() => void loadWorkspace(view, detail?.content.id)}
              >
                <RefreshCw aria-hidden="true" />
              </button>
              {view === 'mine' && me?.roles.includes('SUBMITTER') && (
                <button
                  type="button"
                  className="icon-button primary-icon"
                  title="创建内容"
                  aria-label="创建内容"
                  onClick={() => setEditor('create')}
                >
                  <FilePlus2 aria-hidden="true" />
                </button>
              )}
            </div>
          </header>

          {loading && items.length === 0 ? (
            <div className="loading-state">
              <LoaderCircle aria-hidden="true" />
              加载中…
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              <Inbox aria-hidden="true" />
              <strong>暂无内容</strong>
              <span>
                {view === 'pending' ? '当前没有需要你处理的审核' : '列表还是空的'}
              </span>
            </div>
          ) : (
            <div className="content-list">
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`content-list-item ${detail?.content.id === item.id ? 'selected' : ''}`}
                  onClick={() => void openContent(item.id)}
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
                  <span className="list-item-meta">
                    {item.author.name}
                    {item.currentRound && (
                      <>
                        {' '}· R{item.currentRound.roundNo} · {item.currentRound.approvalCount}/
                        {item.currentRound.requiredApprovals}
                      </>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="detail-pane">
          {loading && !detail ? (
            <div className="loading-state">
              <LoaderCircle aria-hidden="true" />
              加载中…
            </div>
          ) : detail ? (
            <ContentDetail
              key={`${detail.content.id}-${detail.history[0]?.id ?? 'draft'}`}
              detail={detail}
              busy={busy}
              onEdit={() => setEditor('edit')}
              onSubmit={submitCurrent}
              onDecision={decideCurrent}
            />
          ) : (
            <div className="empty-detail">
              <ShieldCheck aria-hidden="true" />
              <h2>选择一条内容</h2>
              <p>详情、审核进度和历史会显示在这里。</p>
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
    </div>
  )
}

function availableViews(user: User): ViewKey[] {
  const result: ViewKey[] = []
  if (user.roles.includes('SUBMITTER')) result.push('mine')
  if (user.roles.includes('REVIEWER')) result.push('pending')
  if (user.roles.includes('ADMIN')) result.push('all')
  return result
}

function firstView(user: User): ViewKey {
  return availableViews(user)[0] ?? 'mine'
}

export default App