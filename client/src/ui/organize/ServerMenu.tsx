// A server's own menu (right-click its icon in the rail, or the server name above the channels): its settings
// sections grouped as in Settings, plus invite and create channel. Only what your role allows.
import { Fragment } from 'react'
import { create } from 'zustand'
import { useTranslation } from 'react-i18next'
import { roleRank } from '../../core/protocol'
import { desktop } from '../../platform/desktop'
import { has } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import { useApp, type ServerState } from '../../state/store'
import { CreateChannelDialog } from '../dialogs/CreateChannelDialog'
import { InviteDialog } from '../dialogs/InviteDialog'
import { SettingsDialog } from '../settings/SettingsDialog'
import { settingsSections, type SectionId } from '../settings/sections'
import { MenuItem } from './OrgMenu'

export type ServerAction = { kind: 'settings'; section: SectionId } | { kind: 'invite' } | { kind: 'channel' }

const GROUPS: { title: 'server' | 'safety' | 'content' | 'hosting'; ids: SectionId[] }[] = [
  { title: 'server', ids: ['overview', 'roles', 'rules', 'limits'] },
  { title: 'safety', ids: ['reports', 'automod', 'audit', 'securityLog'] },
  { title: 'content', ids: ['emoji', 'sounds', 'integrations', 'pages'] },
  { title: 'hosting', ids: ['internet', 'backup', 'import', 'updates'] },
]

/** The rows, for inside an OrgMenu's list. */
export function ServerMenuItems({ server, onPick }: { server: ServerState; onPick: (action: ServerAction) => void }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const me = server.me
  const sections = settingsSections(me?.role, (perm) => has(me, roles, perm), !!desktop).filter((s) => s.group === 'server')
  const label = new Map(sections.map((s) => [s.id, s.label]))
  const canInvite = me ? roleRank(me.role) >= roleRank('member') : false
  const canCreate = has(me, roles, 'manageChannels')
  if (!me) return null
  let first = true
  return (
    <>
      {GROUPS.map(({ title, ids }) => {
        const shown = ids.filter((id) => label.has(id))
        const extra = title === 'server' && (canInvite || canCreate)
        if (shown.length === 0 && !extra) return null
        const separator = !first
        first = false
        return (
          <Fragment key={title}>
            {separator && <div className="org-sep" role="separator" />}
            <div className="org-group-title" aria-hidden>{t(`app.serverMenu.groups.${title}`)}</div>
            {shown.map((id) => (
              <MenuItem key={id} onClick={() => onPick({ kind: 'settings', section: id })}>
                {id === 'overview' ? t('app.serverMenu.settings') : id === 'rules' ? t('app.serverMenu.editRules') : label.get(id)}
              </MenuItem>
            ))}
            {title === 'server' && canInvite && <MenuItem onClick={() => onPick({ kind: 'invite' })}>{t('app.sidebar.inviteFriends')}</MenuItem>}
            {title === 'server' && canCreate && <MenuItem onClick={() => onPick({ kind: 'channel' })}>{t('app.serverMenu.createChannel')}</MenuItem>}
          </Fragment>
        )
      })}
      <div className="org-sep" role="separator" />
      <MenuItem onClick={() => onPick({ kind: 'settings', section: 'overview' })}>{t('app.serverMenu.notifications')}</MenuItem>
      <MenuItem danger onClick={() => onPick({ kind: 'settings', section: 'overview' })}>{t('settings.overview.removeServer')}</MenuItem>
    </>
  )
}

/** The dialog a picked action opens, for that server (rendered once by the Shell). */
const useServerDialog = create<{ open: { serverKey: string; action: ServerAction } | null }>(() => ({ open: null }))

export const openServerAction = (serverKey: string, action: ServerAction) => useServerDialog.setState({ open: { serverKey, action } })

export function ServerActionLayer() {
  const open = useServerDialog((s) => s.open)
  const server = useApp((s) => (open ? s.servers[open.serverKey] : undefined))
  if (!open || !server) return null
  const close = () => useServerDialog.setState({ open: null })
  const { action } = open
  if (action.kind === 'invite') return <InviteDialog server={server} onClose={close} />
  if (action.kind === 'channel') return <CreateChannelDialog server={server} categoryId={null} onClose={close} />
  return <SettingsDialog key={`${server.key}:${action.section}`} server={server} section={action.section} onClose={close} />
}
