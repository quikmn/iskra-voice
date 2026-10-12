// A server's own menu (right-click or press and hold its icon in the rail, or the server name above the channels).
// First the common things flat (Invite friends, Create channel, Server settings, Members, Roles, Reports), the
// rest under "More settings" (or all flat when there are only a few, see serverMenuLayout), then the personal
// per-server items, then Leave. Every settings row opens the server room for THIS server at that section.
import { useState } from 'react'
import { create } from 'zustand'
import { useTranslation } from 'react-i18next'
import { roleRank } from '../../core/protocol'
import { has } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import { useReports } from '../../state/reports'
import { leaveServer, useApp, type ServerState } from '../../state/store'
import { markServerRead } from '../../state/unread'
import { newFolderId, setRail, useRail } from '../../state/rail'
import { moveServer, newFolder, stepServer, updateFolder, visibleRail, type RailFolder } from '../../state/railLogic'
import { Modal } from '../bits'
import { CreateChannelDialog } from '../dialogs/CreateChannelDialog'
import { InviteDialog } from '../dialogs/InviteDialog'
import { ServerRulesItem } from '../rules/Rules'
import { openServerSettings } from '../settings/open'
import { serverSections, type ServerSectionId } from '../settings/sections'
import { ServerTile } from '../settings/ServerTile'
import { FolderDialog } from './FolderDialog'
import { NotifyRows, NotifyViews, useRunner, type Run } from './Menus'
import { MenuItem, MenuTitle, OrgMenu, type MenuAnchor } from './OrgMenu'
import { NicknameField } from './ServerSettings'
import { serverMenuLayout } from './serverMenuLayout'

export type ServerAction = { kind: 'invite' } | { kind: 'channel' } | { kind: 'nickname' } | { kind: 'leave' } | { kind: 'folder'; folderId: string }

type View = 'menu' | 'more' | 'levels' | 'mute' | 'move'

export function ServerMenu({ server, anchor, onClose }: { server: ServerState; anchor: MenuAnchor | null; onClose: () => void }) {
  const { t } = useTranslation()
  const [view, setView] = useState<View>('menu')
  const [run, error] = useRunner(onClose)
  const roles = useServerRoles(server.key)
  const reports = useReports((s) => s.open[server.key] ?? 0)
  const me = server.me
  const sections = serverSections(me?.role, (perm) => has(me, roles, perm))
  const label = new Map(sections.map((s) => [s.id, s.label]))
  const { rows, more } = serverMenuLayout(sections.map((s) => s.id), {
    invite: !!me && roleRank(me.role) >= roleRank('member'),
    createChannel: has(me, roles, 'manageChannels'),
  })
  const pick = (action: ServerAction) => () => {
    onClose()
    openServerAction(server.key, action)
  }
  const open = (section: ServerSectionId) => () => {
    onClose()
    openServerSettings(server.key, section)
  }
  const back = () => setView('menu')

  return (
    <OrgMenu anchor={anchor} label={t('app.rail.options', { name: server.name })} onClose={onClose}>
      {view === 'levels' || view === 'mute' ? (
        <NotifyViews server={server} channelId={null} view={view} setView={back} run={run} />
      ) : view === 'more' ? (
        <>
          <MenuTitle onBack={back}>{server.name}</MenuTitle>
          <div className="org-list" role="menu">
            {more.map((id) => <MenuItem key={id} onClick={open(id)}>{label.get(id)}</MenuItem>)}
          </div>
        </>
      ) : view === 'move' ? (
        <>
          <MenuTitle onBack={back}>{t('app.serverMenu.moveFolder')}</MenuTitle>
          <MoveRows serverKey={server.key} run={run} onNewFolder={(folderId) => { onClose(); openServerAction(server.key, { kind: 'folder', folderId }) }} />
        </>
      ) : (
        <>
          <MenuTitle><span className="server-menu-title"><ServerTile server={server} size="small" /><span>{server.name}</span></span></MenuTitle>
          <div className="org-list" role="menu">
            {rows.map((row) => {
              switch (row.kind) {
                case 'invite': return <MenuItem key="invite" onClick={pick({ kind: 'invite' })}>{t('app.sidebar.inviteFriends')}</MenuItem>
                case 'channel': return <MenuItem key="channel" onClick={pick({ kind: 'channel' })}>{t('app.serverMenu.createChannel')}</MenuItem>
                case 'settings': return <MenuItem key="settings" onClick={open(row.section)}>{t('app.serverMenu.settings')}</MenuItem>
                case 'section': return (
                  <MenuItem key={row.section} onClick={open(row.section)} hint={row.section === 'reports' && reports > 0 ? String(reports) : undefined}>
                    {label.get(row.section)}
                  </MenuItem>
                )
                case 'more': return <MenuItem key="more" onClick={() => setView('more')} hint="›">{t('app.serverMenu.more')}</MenuItem>
              }
            })}
            <ServerRulesItem serverKey={server.key} onDone={onClose} />
            <div className="org-sep" role="separator" />
            {me && <NotifyRows server={server} channelId={null} setView={setView} run={run} />}
            {me && <MenuItem onClick={pick({ kind: 'nickname' })}>{t('app.serverMenu.nickname')}</MenuItem>}
            <MenuItem onClick={run(() => markServerRead(server.key))}>{t('app.rail.markRead')}</MenuItem>
            <MenuItem onClick={() => setView('move')} hint="›">{t('app.serverMenu.moveFolder')}</MenuItem>
            <div className="org-sep" role="separator" />
            <MenuItem danger onClick={pick({ kind: 'leave' })}>{t('app.serverMenu.leave')}</MenuItem>
          </div>
        </>
      )}
      {error && <p className="error-text sheet-error" role="alert">{error}</p>}
    </OrgMenu>
  )
}

/** Moving the server in the rail and in or out of folders (Move up/down too, for keyboards and screen readers). */
function MoveRows({ serverKey, run, onNewFolder }: { serverKey: string; run: Run; onNewFolder: (folderId: string) => void }) {
  const { t } = useTranslation()
  const layout = useRail((s) => s.layout)
  const order = useApp((s) => s.order)
  const folders = visibleRail(layout, order).filter((i): i is RailFolder => i.kind === 'folder')
  const inFolder = folders.find((f) => f.servers.includes(serverKey))
  return (
    <div className="org-list" role="menu">
      <MenuItem onClick={run(() => setRail(stepServer(layout, order, serverKey, -1)))}>{t('app.rail.moveUp')}</MenuItem>
      <MenuItem onClick={run(() => setRail(stepServer(layout, order, serverKey, 1)))}>{t('app.rail.moveDown')}</MenuItem>
      {inFolder ? (
        <MenuItem onClick={run(() => setRail(moveServer(layout, order, serverKey, { kind: 'after', target: inFolder.id }, newFolderId)))}>
          {t('app.rail.removeFromFolder')}
        </MenuItem>
      ) : (
        <>
          {folders.map((f) => (
            <MenuItem key={f.id} onClick={run(() => setRail(moveServer(layout, order, serverKey, { kind: 'into', folder: f.id }, newFolderId)))}>
              {f.name ? t('app.rail.addTo', { name: f.name }) : t('app.rail.addToFolder')}
            </MenuItem>
          ))}
          <MenuItem onClick={() => {
            const id = newFolderId()
            setRail(newFolder(layout, order, serverKey, id))
            onNewFolder(id)
          }}>{t('app.rail.newFolder')}</MenuItem>
        </>
      )}
    </div>
  )
}

/** The dialog a picked action opens, for that server (rendered once by the Shell). */
const useServerDialog = create<{ open: { serverKey: string; action: ServerAction } | null }>(() => ({ open: null }))

export const openServerAction = (serverKey: string, action: ServerAction) => useServerDialog.setState({ open: { serverKey, action } })

export function ServerActionLayer() {
  const open = useServerDialog((s) => s.open)
  const server = useApp((s) => (open ? s.servers[open.serverKey] : undefined))
  const layout = useRail((s) => s.layout)
  if (!open || !server) return null
  const close = () => useServerDialog.setState({ open: null })
  const { action } = open
  switch (action.kind) {
    case 'invite': return <InviteDialog server={server} onClose={close} />
    case 'channel': return <CreateChannelDialog server={server} categoryId={null} onClose={close} />
    case 'nickname': return <NicknameDialog server={server} onClose={close} />
    case 'leave': return <LeaveDialog server={server} onClose={close} />
    case 'folder': {
      const folder = layout.items.find((i): i is RailFolder => i.kind === 'folder' && i.id === action.folderId)
      if (!folder) return null
      return <FolderDialog folder={folder} onClose={close} onSave={(patch) => setRail(updateFolder(useRail.getState().layout, folder.id, patch))} />
    }
  }
}

function NicknameDialog({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const { t } = useTranslation()
  if (!server.me) return null
  return (
    <Modal title={t('app.serverMenu.nicknameTitle', { name: server.name })} onClose={onClose}>
      <NicknameField server={server} member={server.me} />
    </Modal>
  )
}

function LeaveDialog({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Modal
      title={t('app.serverMenu.leaveTitle', { name: server.name })}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button danger" onClick={() => { leaveServer(server.key); onClose() }}>{t('app.serverMenu.leave')}</button>
        </>
      }
    >
      <p className="muted">{t('settings.overview.removeHint')}</p>
    </Modal>
  )
}
