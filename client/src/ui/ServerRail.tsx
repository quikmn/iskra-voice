// The server rail: DMs, then your servers and folders. Drag to reorder (onto another server to make a folder);
// right-click or press and hold for a menu. The layout syncs across your devices (state/rail.ts).
import { useRef, useState, type DragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { selectServer, useApp, type ServerState } from '../state/store'
import { openFriends } from '../state/dms'
import { initials } from './format'
import { Plus } from './icons'
import { useOrganize } from '../state/organize'
import { newFolderId, setRail, useRail } from '../state/rail'
import { moveFolder, moveServer, newFolder, stepServer, ungroup, updateFolder, visibleRail, type RailFolder } from '../state/railLogic'
import { homeUnread, markServerRead, serverBadges } from '../state/unread'
import { useReads } from '../state/readState'
import { useThreads } from '../state/threads'
import { MenuItem, MenuTitle, OrgMenu, type MenuAnchor } from './organize/OrgMenu'
import { FolderDialog } from './organize/FolderDialog'
import { ServerRulesItem } from './rules/Rules'
import './organize/organize.css'

type Drag = { kind: 'server' | 'folder'; id: string }
type Spot = 'before' | 'after' | 'combine'
type Dnd = Record<string, unknown>

/** Press and hold on touch screens; the click that follows is swallowed. */
function useHold(onHold: (anchor: MenuAnchor) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      held.current = false
      if (e.pointerType !== 'touch') return
      start.current = { x: e.clientX, y: e.clientY }
      const rect = e.currentTarget.getBoundingClientRect()
      timer.current = setTimeout(() => {
        held.current = true
        navigator.vibrate?.(10)
        onHold({ x: rect.right + 4, y: rect.top })
      }, 450)
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: MouseEvent) => {
      if (held.current) {
        e.preventDefault()
        e.stopPropagation()
        held.current = false
      }
    },
  }
}

export function ServerRail({ onJoin, onNavigate }: { onJoin: () => void; onNavigate: () => void }) {
  const { t } = useTranslation()
  const order = useApp((s) => s.order)
  const servers = useApp((s) => s.servers)
  const active = useApp((s) => s.activeServer)
  const layout = useRail((s) => s.layout)
  useOrganize((s) => s.notify) // badges follow notification settings
  useOrganize((s) => s.clock)
  const dmUnread = useReads((s) => homeUnread(s.convs))
  useReads((s) => s.convs) // server badges follow read state
  useThreads((s) => s.threads) // (thread counts belong to their channel)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<{ id: string; spot: Spot } | null>(null)
  const [menu, setMenu] = useState<{ kind: 'server' | 'folder'; id: string; anchor: MenuAnchor | null } | null>(null)
  const [editing, setEditing] = useState<RailFolder | null>(null)
  const items = visibleRail(layout, order)
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

  const endDrag = () => {
    setDrag(null)
    setOver(null)
  }

  const drop = (target: string, spot: Spot, targetIsFolder: boolean, insideFolder: boolean) => {
    if (!drag) return
    if (drag.kind === 'folder') {
      if (insideFolder) return
      setRail(moveFolder(layout, order, drag.id, { kind: spot === 'after' ? 'after' : 'before', target }))
    } else if (spot === 'combine') {
      setRail(moveServer(layout, order, drag.id, targetIsFolder ? { kind: 'into', folder: target } : { kind: 'combine', target }, newFolderId))
    } else {
      setRail(moveServer(layout, order, drag.id, { kind: spot, target }, newFolderId))
    }
  }

  /** Drag handlers for an icon: top quarter = before, bottom quarter = after, the middle = into a folder / make one. */
  const dnd = (d: Drag, targetIsFolder: boolean, insideFolder: boolean): Dnd => touch ? {} : {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-iskra-rail', d.id)
      e.dataTransfer.setData('text/plain', '')
      setDrag(d)
    },
    onDragEnd: endDrag,
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag || drag.id === d.id || (drag.kind === 'folder' && insideFolder)) return
      e.preventDefault()
      e.stopPropagation()
      const rect = e.currentTarget.getBoundingClientRect()
      const y = (e.clientY - rect.top) / rect.height
      const spot: Spot = drag.kind === 'folder'
        ? (y < 0.5 ? 'before' : 'after')
        : y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'combine'
      if (over?.id !== d.id || over.spot !== spot) setOver({ id: d.id, spot })
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o?.id === d.id ? null : o))
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      e.stopPropagation()
      if (over?.id === d.id) drop(d.id, over.spot, targetIsFolder, insideFolder)
      endDrag()
    },
  }

  const dropClass = (id: string) => (over?.id === id ? `drop-${over.spot}` : '') + (drag?.id === id ? ' dragging' : '')

  const openMenu = (kind: 'server' | 'folder', id: string) => (e: MouseEvent<HTMLElement>) => {
    e.preventDefault()
    setMenu({ kind, id, anchor: { x: e.clientX, y: e.clientY } })
  }

  const icon = (key: string, insideFolder: boolean) => {
    const server = servers[key]
    if (!server) return null
    return (
      <ServerIcon key={key} server={server} active={key === active} className={dropClass(key)} dnd={dnd({ kind: 'server', id: key }, false, insideFolder)}
        onContextMenu={openMenu('server', key)} onHold={(anchor) => setMenu({ kind: 'server', id: key, anchor })}
        onClick={() => {
          selectServer(key)
          onNavigate()
        }} />
    )
  }

  const menuServer = menu?.kind === 'server' ? servers[menu.id] : undefined
  const folders = items.filter((i): i is RailFolder => i.kind === 'folder')
  const menuFolder = menu?.kind === 'folder' ? folders.find((f) => f.id === menu.id) : undefined
  const folderOfMenu = menuServer ? folders.find((f) => f.servers.includes(menuServer.key)) : undefined
  const close = () => setMenu(null)
  const act = (action: () => void) => () => {
    action()
    close()
  }

  return (
    <nav className="server-rail" aria-label={t('app.rail.servers')}>
      <button
        className={`server-icon home ${active === null ? 'active' : ''}`}
        title={t('app.home.directMessages')}
        aria-label={t('app.home.directMessages')}
        onClick={() => {
          openFriends()
          onNavigate()
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="currentColor" /></svg>
        {dmUnread > 0 && active !== null && <span className="badge">{dmUnread > 99 ? '99+' : dmUnread}</span>}
      </button>
      <div className="rail-divider" />
      {items.map((item) => item.kind === 'server' ? icon(item.key, false) : (
        <Folder key={item.id} folder={item} servers={servers} active={active} className={dropClass(item.id)}
          dnd={dnd({ kind: 'folder', id: item.id }, true, false)}
          onContextMenu={openMenu('folder', item.id)} onHold={(anchor) => setMenu({ kind: 'folder', id: item.id, anchor })}
          onToggle={() => setRail(updateFolder(layout, item.id, { collapsed: !item.collapsed }))}>
          {item.servers.map((key) => icon(key, true))}
        </Folder>
      ))}
      <button className="server-icon add" title={t('app.rail.join')} onClick={onJoin} aria-label={t('app.rail.join')}>
        <Plus size={22} />
      </button>

      {menuServer && (
        <OrgMenu anchor={menu!.anchor} label={t('app.rail.options', { name: menuServer.name })} onClose={close}>
          <MenuTitle>{menuServer.name}</MenuTitle>
          <div className="org-list" role="menu">
            <MenuItem onClick={act(() => markServerRead(menuServer.key))}>{t('app.rail.markRead')}</MenuItem>
            <ServerRulesItem serverKey={menuServer.key} onDone={close} />
            <div className="org-sep" role="separator" />
            <MenuItem onClick={act(() => setRail(stepServer(layout, order, menuServer.key, -1)))}>{t('app.rail.moveUp')}</MenuItem>
            <MenuItem onClick={act(() => setRail(stepServer(layout, order, menuServer.key, 1)))}>{t('app.rail.moveDown')}</MenuItem>
            {folderOfMenu ? (
              <MenuItem onClick={act(() => setRail(moveServer(layout, order, menuServer.key, { kind: 'after', target: folderOfMenu.id }, newFolderId)))}>
                {t('app.rail.removeFromFolder')}
              </MenuItem>
            ) : (
              <>
                {folders.map((f) => (
                  <MenuItem key={f.id} onClick={act(() => setRail(moveServer(layout, order, menuServer.key, { kind: 'into', folder: f.id }, newFolderId)))}>
                    {f.name ? t('app.rail.addTo', { name: f.name }) : t('app.rail.addToFolder')}
                  </MenuItem>
                ))}
                <MenuItem onClick={act(() => {
                  const id = newFolderId()
                  const next = newFolder(layout, order, menuServer.key, id)
                  setRail(next)
                  setEditing(next.find((i): i is RailFolder => i.kind === 'folder' && i.id === id) ?? null)
                })}>{t('app.rail.newFolder')}</MenuItem>
              </>
            )}
          </div>
        </OrgMenu>
      )}
      {menuFolder && (
        <OrgMenu anchor={menu!.anchor} label={t('app.rail.options', { name: menuFolder.name || t('app.rail.folder') })} onClose={close}>
          <MenuTitle>{menuFolder.name || t('app.rail.folder')}</MenuTitle>
          <div className="org-list" role="menu">
            <MenuItem onClick={act(() => menuFolder.servers.forEach(markServerRead))}>{t('app.rail.markAllRead')}</MenuItem>
            <MenuItem onClick={act(() => setEditing(menuFolder))}>{t('app.rail.folderSettings')}</MenuItem>
            <MenuItem onClick={act(() => setRail(updateFolder(layout, menuFolder.id, { collapsed: !menuFolder.collapsed })))}>
              {menuFolder.collapsed ? t('app.rail.openFolder') : t('app.rail.closeFolder')}
            </MenuItem>
            <MenuItem onClick={act(() => setRail(ungroup(layout, menuFolder.id)))}>{t('app.rail.ungroup')}</MenuItem>
          </div>
        </OrgMenu>
      )}
      {editing && (
        <FolderDialog folder={editing} onClose={() => setEditing(null)}
          onSave={(patch) => setRail(updateFolder(useRail.getState().layout, editing.id, patch))} />
      )}
    </nav>
  )
}

function ServerIcon({ server, active, className, dnd, onClick, onContextMenu, onHold }: {
  server: ServerState; active: boolean; className: string; dnd: Dnd
  onClick: () => void; onContextMenu: (e: MouseEvent<HTMLElement>) => void; onHold: (a: MenuAnchor) => void
}) {
  const hold = useHold(onHold)
  const { unread, pings } = serverBadges(server)
  const offline = server.status.state !== 'online'
  return (
    <button
      className={`server-icon ${active ? 'active' : ''} ${offline ? 'offline' : ''} ${className}`}
      title={server.name}
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...hold}
      {...dnd}
    >
      {initials(server.name)}
      {pings > 0 && !active && <span className="badge">{pings > 99 ? '99+' : pings}</span>}
      {pings === 0 && unread > 0 && !active && <span className="unread-dot" />}
    </button>
  )
}

function Folder({ folder, servers, active, className, dnd, onToggle, onContextMenu, onHold, children }: {
  folder: RailFolder; servers: Record<string, ServerState>; active: string | null; className: string; dnd: Dnd
  onToggle: () => void; onContextMenu: (e: MouseEvent<HTMLElement>) => void; onHold: (a: MenuAnchor) => void; children: ReactNode
}) {
  const { t } = useTranslation()
  const hold = useHold(onHold)
  const members = folder.servers.map((k) => servers[k]).filter((s): s is ServerState => !!s)
  const totals = members.map(serverBadges)
  const pings = totals.reduce((n, b) => n + b.pings, 0)
  const unread = totals.reduce((n, b) => n + b.unread, 0)
  const holdsActive = !!active && folder.servers.includes(active)
  const label = folder.name || members.map((s) => s.name).join(', ')
  return (
    <div className={`rail-folder ${folder.collapsed ? 'collapsed' : 'open'}`} style={{ ['--folder' as string]: folder.color }}>
      <button
        className={`server-icon folder-icon ${folder.collapsed && holdsActive ? 'active' : ''} ${className}`}
        title={label}
        aria-label={t('app.rail.folderLabel', { name: label })}
        aria-expanded={!folder.collapsed}
        onClick={onToggle}
        onContextMenu={onContextMenu}
        {...hold}
        {...dnd}
      >
        {folder.collapsed ? (
          <span className="folder-grid" aria-hidden>
            {members.slice(0, 4).map((s) => <span key={s.key}>{initials(s.name).slice(0, 1)}</span>)}
          </span>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M3 6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6L12 6h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
        )}
        {folder.collapsed && pings > 0 && <span className="badge">{pings > 99 ? '99+' : pings}</span>}
        {folder.collapsed && pings === 0 && unread > 0 && <span className="unread-dot" />}
      </button>
      {!folder.collapsed && children}
    </div>
  )
}
