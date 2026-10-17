// Settings navigation, in two separate places: "My settings" (only about you, everywhere) and one server's
// "Server settings" (only its shared config, grouped, limited to what your role and permissions allow).
import { roleRank, type Permission, type Role } from '../../core/protocol'
import { t } from '../../i18n'

export type MySectionId =
  | 'profile' | 'appearance' | 'language' | 'devices' | 'recovery' | 'security' | 'notifications' | 'streamer' | 'voice' | 'video' | 'blocked' | 'desktop' | 'account' | 'assistant' | 'privacy' | 'about'

export type ServerSectionId =
  | 'overview' | 'channels' | 'serverVoice' | 'emoji' | 'gifs' | 'sounds' | 'pages' | 'rules' | 'onboarding'
  | 'members' | 'roles' | 'reports' | 'automod' | 'audit' | 'securityLog'
  | 'integrations' | 'activities' | 'bugInbox'
  | 'internet' | 'limits' | 'backup' | 'export' | 'import' | 'updates' | 'translate'

export type SectionId = MySectionId | ServerSectionId

export type ServerGroup = 'server' | 'safety' | 'apps' | 'hosting'

export interface SectionInfo<Id extends SectionId = SectionId> {
  id: Id
  label: string
}

export interface ServerSectionInfo extends SectionInfo<ServerSectionId> {
  group: ServerGroup
}

const MINE: MySectionId[] = ['profile', 'appearance', 'language', 'devices', 'recovery', 'security', 'notifications', 'streamer', 'voice', 'video', 'blocked', 'desktop', 'account', 'assistant', 'privacy', 'about']

/** Any of these opens Members and Reports (the ones that act on people). */
const MODERATION: Permission[] = ['manageMessages', 'timeoutMembers', 'kickMembers', 'banMembers']

/** Server sections in nav order: the lowest level that may open each, or permissions (from a custom role) that also open it. */
const SERVER: { id: ServerSectionId; group: ServerGroup; min: Role; perms?: Permission[] }[] = [
  { id: 'overview', group: 'server', min: 'admin' },
  { id: 'channels', group: 'server', min: 'admin', perms: ['manageChannels'] },
  { id: 'serverVoice', group: 'server', min: 'admin' },
  { id: 'emoji', group: 'server', min: 'admin', perms: ['manageExpressions'] },
  { id: 'gifs', group: 'server', min: 'admin' },
  { id: 'sounds', group: 'server', min: 'trusted', perms: ['manageExpressions'] },
  { id: 'pages', group: 'server', min: 'admin' },
  { id: 'rules', group: 'server', min: 'admin' },
  { id: 'onboarding', group: 'server', min: 'admin', perms: ['manageRoles'] },
  { id: 'translate', group: 'server', min: 'owner' },
  { id: 'members', group: 'safety', min: 'admin', perms: [...MODERATION, 'manageRoles'] },
  { id: 'roles', group: 'safety', min: 'admin', perms: ['manageRoles'] },
  { id: 'reports', group: 'safety', min: 'admin', perms: MODERATION },
  { id: 'automod', group: 'safety', min: 'admin', perms: ['manageAutoMod'] },
  { id: 'audit', group: 'safety', min: 'admin', perms: ['viewAuditLog'] },
  { id: 'securityLog', group: 'safety', min: 'owner' },
  { id: 'integrations', group: 'apps', min: 'admin', perms: ['manageWebhooks'] },
  { id: 'activities', group: 'apps', min: 'admin' },
  { id: 'bugInbox', group: 'apps', min: 'owner' },
  { id: 'internet', group: 'hosting', min: 'admin' },
  { id: 'limits', group: 'hosting', min: 'owner' },
  { id: 'backup', group: 'hosting', min: 'owner' },
  { id: 'export', group: 'hosting', min: 'admin', perms: ['exportChannels'] },
  { id: 'import', group: 'hosting', min: 'owner' },
  { id: 'updates', group: 'hosting', min: 'owner' },
]

export const SERVER_GROUPS: ServerGroup[] = ['server', 'safety', 'apps', 'hosting']

export const isServerSection = (id: SectionId): id is ServerSectionId => SERVER.some((s) => s.id === id)

/** My settings: about you on every server (Desktop app only in the app). Never anything about one server. */
export function mySections(desktopApp = false): SectionInfo<MySectionId>[] {
  return MINE.filter((id) => desktopApp || id !== 'desktop').map((id) => ({ id, label: t(`settings.sections.${id}`) }))
}

/**
 * One server's settings for you: by level, or by a permission a custom role gives. Empty without a membership or
 * without any admin rights (then there's no Server settings at all). `bugInbox`: the server takes bug reports (welcome). The server still checks every request.
 */
export function serverSections(role: Role | null | undefined, can: (perm: Permission) => boolean = () => false, bugInbox = false): ServerSectionInfo[] {
  if (!role) return []
  return SERVER
    .filter((s) => s.id !== 'bugInbox' || bugInbox) // only on the server that takes Iskra's bug reports
    .filter((s) => roleRank(role) >= roleRank(s.min) || s.perms?.some(can))
    .map(({ id, group }) => ({ id, group, label: t(`settings.sections.${id}`) }))
}
