// Settings navigation: your account first, then the server you're looking at, limited to what your role allows.
import { roleRank, type Permission, type Role } from '../../core/protocol'

export type SectionId =
  | 'profile' | 'appearance' | 'devices' | 'recovery' | 'security' | 'notifications' | 'voice' | 'blocked'
  | 'overview' | 'roles' | 'emoji' | 'sounds' | 'integrations' | 'pages' | 'internet' | 'audit' | 'backup' | 'import'

export interface SectionInfo {
  id: SectionId
  label: string
  group: 'account' | 'server'
}

const ACCOUNT: SectionInfo[] = [
  { id: 'profile', label: 'Profile', group: 'account' },
  { id: 'appearance', label: 'Appearance', group: 'account' },
  { id: 'devices', label: 'Devices', group: 'account' },
  { id: 'recovery', label: 'Recovery key', group: 'account' },
  { id: 'security', label: 'App lock', group: 'account' },
  { id: 'notifications', label: 'Notifications', group: 'account' },
  { id: 'voice', label: 'Voice & audio', group: 'account' },
  { id: 'blocked', label: 'Blocked people', group: 'account' },
]

/** Server sections: the lowest level that may open each, or a permission from a custom role that also opens it. */
const SERVER: (SectionInfo & { min: Role; perm?: Permission })[] = [
  { id: 'overview', label: 'Overview', group: 'server', min: 'guest' },
  { id: 'roles', label: 'Roles', group: 'server', min: 'admin', perm: 'manageRoles' },
  { id: 'emoji', label: 'Emoji', group: 'server', min: 'admin', perm: 'manageExpressions' },
  { id: 'sounds', label: 'Soundboard', group: 'server', min: 'trusted', perm: 'manageExpressions' },
  { id: 'integrations', label: 'Bots & webhooks', group: 'server', min: 'admin', perm: 'manageWebhooks' },
  { id: 'pages', label: 'Profile pages', group: 'server', min: 'admin' },
  { id: 'internet', label: 'Open to the internet', group: 'server', min: 'admin' },
  { id: 'audit', label: 'Audit log', group: 'server', min: 'admin', perm: 'viewAuditLog' },
  { id: 'backup', label: 'Backup & move', group: 'server', min: 'owner' },
  { id: 'import', label: 'Import from Discord', group: 'server', min: 'owner' },
]

/** The sections to show: account always; server ones only with a joined server, by level or permission. */
export function settingsSections(role: Role | null | undefined, can: (perm: Permission) => boolean = () => false): SectionInfo[] {
  if (!role) return ACCOUNT
  return [
    ...ACCOUNT,
    ...SERVER.filter((s) => roleRank(role) >= roleRank(s.min) || (s.perm && can(s.perm))).map(({ id, label, group }) => ({ id, label, group })),
  ]
}
