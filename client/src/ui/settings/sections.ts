// Settings navigation: your account first, then the server you're looking at, limited to what your role allows.
import { roleRank, type Role } from '../../core/protocol'

export type SectionId =
  | 'profile' | 'appearance' | 'devices' | 'recovery' | 'notifications' | 'voice'
  | 'overview' | 'emoji' | 'sounds' | 'integrations' | 'pages' | 'internet'

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
  { id: 'notifications', label: 'Notifications', group: 'account' },
  { id: 'voice', label: 'Voice & audio', group: 'account' },
]

/** Server sections and the lowest role that may open each. */
const SERVER: (SectionInfo & { min: Role })[] = [
  { id: 'overview', label: 'Overview', group: 'server', min: 'guest' },
  { id: 'emoji', label: 'Emoji', group: 'server', min: 'admin' },
  { id: 'sounds', label: 'Soundboard', group: 'server', min: 'trusted' },
  { id: 'integrations', label: 'Bots & webhooks', group: 'server', min: 'admin' },
  { id: 'pages', label: 'Profile pages', group: 'server', min: 'admin' },
  { id: 'internet', label: 'Open to the internet', group: 'server', min: 'admin' },
]

/** The sections to show: account always; server ones only with a joined server, by role. */
export function settingsSections(role: Role | null | undefined): SectionInfo[] {
  if (!role) return ACCOUNT
  return [...ACCOUNT, ...SERVER.filter((s) => roleRank(role) >= roleRank(s.min)).map(({ id, label, group }) => ({ id, label, group }))]
}
