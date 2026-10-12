// Settings navigation: your account first, then the server you're looking at, limited to what your role allows.
import { roleRank, type Permission, type Role } from '../../core/protocol'
import { t } from '../../i18n'

export type SectionId =
  | 'profile' | 'appearance' | 'devices' | 'recovery' | 'security' | 'notifications' | 'voice' | 'video' | 'blocked' | 'desktop' | 'account' | 'privacy' | 'about'
  | 'overview' | 'reports' | 'roles' | 'automod' | 'emoji' | 'sounds' | 'integrations' | 'pages' | 'internet' | 'audit' | 'rules' | 'limits' | 'backup' | 'import'
  | 'securityLog' | 'updates'

export interface SectionInfo {
  id: SectionId
  label: string
  group: 'account' | 'server'
}

type SectionEntry = Omit<SectionInfo, 'label'>

const ACCOUNT: SectionEntry[] = [
  { id: 'profile', group: 'account' },
  { id: 'appearance', group: 'account' },
  { id: 'devices', group: 'account' },
  { id: 'recovery', group: 'account' },
  { id: 'security', group: 'account' },
  { id: 'notifications', group: 'account' },
  { id: 'voice', group: 'account' },
  { id: 'video', group: 'account' },
  { id: 'blocked', group: 'account' },
  { id: 'desktop', group: 'account' },
  { id: 'account', group: 'account' },
  { id: 'privacy', group: 'account' },
  { id: 'about', group: 'account' },
]

/** Server sections: the lowest level that may open each, or a permission from a custom role that also opens it. */
const SERVER: (SectionEntry & { min: Role; perm?: Permission; perms?: Permission[] })[] = [
  { id: 'overview', group: 'server', min: 'guest' },
  // Moderators: any of the permissions that act on reports.
  { id: 'reports', group: 'server', min: 'admin', perms: ['manageMessages', 'timeoutMembers', 'kickMembers', 'banMembers'] },
  { id: 'roles', group: 'server', min: 'admin', perm: 'manageRoles' },
  { id: 'automod', group: 'server', min: 'admin', perm: 'manageAutoMod' },
  { id: 'emoji', group: 'server', min: 'admin', perm: 'manageExpressions' },
  { id: 'sounds', group: 'server', min: 'trusted', perm: 'manageExpressions' },
  { id: 'integrations', group: 'server', min: 'admin', perm: 'manageWebhooks' },
  { id: 'pages', group: 'server', min: 'admin' },
  { id: 'internet', group: 'server', min: 'admin' },
  { id: 'audit', group: 'server', min: 'admin', perm: 'viewAuditLog' },
  { id: 'rules', group: 'server', min: 'admin' },
  { id: 'limits', group: 'server', min: 'owner' },
  { id: 'backup', group: 'server', min: 'owner' },
  { id: 'import', group: 'server', min: 'owner' },
  { id: 'securityLog', group: 'server', min: 'owner' },
  { id: 'updates', group: 'server', min: 'owner' },
]

/** The sections to show: account always (Desktop app only in the app); server ones only with a joined server, by level or permission. */
export function settingsSections(role: Role | null | undefined, can: (perm: Permission) => boolean = () => false, desktopApp = false): SectionInfo[] {
  const account = desktopApp ? ACCOUNT : ACCOUNT.filter((s) => s.id !== 'desktop')
  const labelled = ({ id, group }: SectionEntry): SectionInfo => ({ id, group, label: t(`settings.sections.${id}`) })
  if (!role) return account.map(labelled)
  return [
    ...account,
    ...SERVER.filter((s) => roleRank(role) >= roleRank(s.min) || (s.perm && can(s.perm)) || s.perms?.some(can)),
  ].map(labelled)
}
