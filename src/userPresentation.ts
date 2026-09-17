import type { Role, User } from './types'

const presetUserIds = new Set([
  'user-alice',
  'user-bob',
  'user-chen',
  'user-diana',
])

const roleLabels: Record<Role, string> = {
  SUBMITTER: '提交人',
  REVIEWER: '审核人',
  ADMIN: '管理员',
}
const roleOrder: Role[] = ['SUBMITTER', 'REVIEWER', 'ADMIN']

export function formatRoleLabels(roles: Role[]): string {
  return roleOrder
    .filter((role) => roles.includes(role))
    .map((role) => roleLabels[role])
    .join(' / ')
}

export function formatUserOption(user: User): string {
  return `${user.name} · ${formatRoleLabels(user.roles)}${isPresetUser(user.id) ? '' : ' · 自定义'}`
}

export function isPresetUser(userId: string): boolean {
  return presetUserIds.has(userId)
}
