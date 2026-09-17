import {
  LoaderCircle,
  RefreshCw,
  Save,
  ShieldCheck,
  UserPlus,
  UsersRound,
  X,
} from 'lucide-react'
import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { errorMessage } from '../api'
import type { AdminUser, AdminUserInput, Role } from '../types'

interface AdminUserPanelProps {
  users: AdminUser[]
  currentUserId: string
  loading: boolean
  busy: boolean
  onClose: () => void
  onReload: () => Promise<void>
  onCreate: (input: AdminUserInput) => Promise<void>
  onUpdate: (userId: string, input: AdminUserInput) => Promise<void>
}

const roleOptions: Array<{
  role: Role
  label: string
  description: string
}> = [
  { role: 'SUBMITTER', label: '提交人', description: '创建、编辑并提交自己的内容' },
  { role: 'REVIEWER', label: '审核人', description: '审核其他用户的待审内容' },
  { role: 'ADMIN', label: '管理员', description: '查看全部请求并管理用户角色' },
]

export function AdminUserPanel({
  users,
  currentUserId,
  loading,
  busy,
  onClose,
  onReload,
  onCreate,
  onUpdate,
}: AdminUserPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="admin-dialog"
      aria-labelledby="admin-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header className="dialog-header admin-dialog-header">
        <div className="dialog-heading">
          <UsersRound aria-hidden="true" />
          <div>
            <p className="eyebrow">ADMIN CONSOLE</p>
            <h2 id="admin-title">用户与角色</h2>
          </div>
        </div>
        <div className="admin-header-actions">
          <button
            type="button"
            className="icon-button"
            title="刷新用户"
            aria-label="刷新用户"
            disabled={loading || busy}
            onClick={() => void onReload()}
          >
            <RefreshCw className={loading ? 'spinning' : ''} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            title="关闭"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="admin-policy-note">
        <ShieldCheck aria-hidden="true" />
        <p>
          角色可以叠加。ADMIN 只提供全量查看与用户管理权限，不会自动获得审核权限；
          历史中的作者和审核人姓名始终保留当时快照。
        </p>
      </div>

      <div className="admin-dialog-body">
        <CreateUserForm busy={busy} onCreate={onCreate} />

        <section className="admin-users" aria-labelledby="user-list-title">
          <div className="admin-section-heading">
            <div>
              <p className="eyebrow">MEMBERS</p>
              <h3 id="user-list-title">现有用户</h3>
            </div>
            <span>{users.length} 人</span>
          </div>

          {loading && users.length === 0 ? (
            <div className="loading-state admin-loading">
              <LoaderCircle aria-hidden="true" />
              加载用户…
            </div>
          ) : (
            <div className="admin-user-list">
              {users.map((user) => (
                <UserRoleEditor
                  key={`${user.id}:${user.name}:${[...user.roles].sort().join(',')}`}
                  user={user}
                  isCurrent={user.id === currentUserId}
                  busy={busy}
                  onUpdate={onUpdate}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </dialog>
  )
}

function CreateUserForm({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (input: AdminUserInput) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [roles, setRoles] = useState<Role[]>(['SUBMITTER'])
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    try {
      await onCreate({ name, roles })
      setName('')
      setRoles(['SUBMITTER'])
    } catch (createError) {
      setError(errorMessage(createError))
    }
  }

  return (
    <details className="admin-create">
      <summary>
        <span>
          <UserPlus aria-hidden="true" />
          创建用户
        </span>
        <small>新用户会立即出现在演示用户切换入口</small>
      </summary>
      <form onSubmit={submit}>
        <label className="admin-name-field">
          <span>显示名称</span>
          <input
            value={name}
            maxLength={80}
            required
            placeholder="例如：Eva"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <RoleSelector roles={roles} disabled={busy} onChange={setRoles} />
        {error && <p className="inline-error">{error}</p>}
        <button
          type="submit"
          className="button primary"
          disabled={busy || name.trim().length === 0 || roles.length === 0}
        >
          <UserPlus aria-hidden="true" />
          {busy ? '创建中…' : '创建用户'}
        </button>
      </form>
    </details>
  )
}

function UserRoleEditor({
  user,
  isCurrent,
  busy,
  onUpdate,
}: {
  user: AdminUser
  isCurrent: boolean
  busy: boolean
  onUpdate: (userId: string, input: AdminUserInput) => Promise<void>
}) {
  const [name, setName] = useState(user.name)
  const [roles, setRoles] = useState<Role[]>(user.roles)
  const [error, setError] = useState('')

  const dirty =
    name.trim() !== user.name ||
    [...roles].sort().join(',') !== [...user.roles].sort().join(',')

  async function save() {
    setError('')
    try {
      await onUpdate(user.id, { name, roles })
    } catch (updateError) {
      setError(errorMessage(updateError))
    }
  }

  return (
    <article className="admin-user-card">
      <div className="admin-user-identity">
        <span className="user-avatar" aria-hidden="true">
          {user.name.slice(0, 1).toLocaleUpperCase()}
        </span>
        <label>
          <span className="sr-only">{user.name} 的显示名称</span>
          <input
            value={name}
            maxLength={80}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {isCurrent && <b>当前用户</b>}
      </div>
      <div className="admin-user-stats">
        <span>{user.contentCount} 条内容</span>
        <span>{user.decisionCount} 次审核</span>
      </div>
      <RoleSelector roles={roles} disabled={busy} onChange={setRoles} />
      {error && <p className="inline-error">{error}</p>}
      <div className="admin-user-actions">
        <small>
          {user.roles.includes('ADMIN') ? '系统至少保留一位管理员' : '不提供删除，以保护审计历史'}
        </small>
        <button
          type="button"
          className="button secondary"
          disabled={
            busy ||
            !dirty ||
            name.trim().length === 0 ||
            roles.length === 0
          }
          onClick={() => void save()}
        >
          <Save aria-hidden="true" />
          保存变更
        </button>
      </div>
    </article>
  )
}

function RoleSelector({
  roles,
  disabled,
  onChange,
}: {
  roles: Role[]
  disabled: boolean
  onChange: (roles: Role[]) => void
}) {
  function toggle(role: Role, checked: boolean) {
    onChange(
      checked
        ? [...roles, role]
        : roles.filter((currentRole) => currentRole !== role),
    )
  }

  return (
    <fieldset className="role-selector">
      <legend>角色</legend>
      <div>
        {roleOptions.map((option) => (
          <label key={option.role} title={option.description}>
            <input
              type="checkbox"
              checked={roles.includes(option.role)}
              disabled={disabled}
              onChange={(event) => toggle(option.role, event.target.checked)}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.role}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
