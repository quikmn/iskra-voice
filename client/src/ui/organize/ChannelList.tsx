// The channel list: uncategorized channels at the top (text, then voice), then categories you can collapse.
// Admins drag channels and categories to arrange them on desktop; every row also has a menu (right click, or the
// ⋯ button, which phones always show).
import { useState, type DragEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent } from 'react'
import { LockBadge } from '../e2ee/E2ee'
import { useTranslation } from 'react-i18next'
import { levelName } from '../../state/permissions'
import type { Category, Channel } from '../../core/protocol'
import { activeChannelId, selectChannel, useApp, type ServerState } from '../../state/store'
import { joinVoice, setStageOpen, useVoice } from '../../state/voice'
import { useChannelCounts } from '../../state/unread'
import { openProfileCard } from '../../state/profile'
import { moveCategory, moveChannel, toggleCollapsed, useCategories, useNotifyFor, useOrganize } from '../../state/organize'
import { channelBadges, dropOnCategory, dropOnChannel, isVoiceLike, layoutChannels } from '../../state/organizeLogic'
import { ChannelKindIcon } from '../ChannelKindIcon'
import { StartHereEntry } from '../docs/StartHere'
import { StageEntry } from '../stage/StageSidebar'
import { Avatar } from '../bits'
import { ChevronDown, HeadphonesOff, Lock, MicOff, Plus, Volume } from '../icons'
import { CategoryMenu, ChannelMenu } from './Menus'
import { CategoryDialog, ChannelSettingsDialog } from './Dialogs'
import type { MenuAnchor } from './OrgMenu'
import { isMenuKey } from '../roving'
import { has } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import { showRules, useMustAgree } from '../../state/rules'
import { isFull, limitLabel } from '../../state/voiceRulesLogic'
import '../rules/rules.css'
import './organize.css'
import { userMenuProps } from '../people/userMenuProps'
import { useAfkChannel } from '../../state/afk'
import '../afk/afk.css'
import { VoiceChatRowButton } from '../clips/VoiceChatRowButton'
import { ClipsMark } from '../clips/ClipControls'
import { BotBadge } from '../chat/BotBits'

type Drag = { kind: 'channel' | 'category'; id: number }
type Over = { kind: 'channel' | 'category' | 'top'; id: number; after?: boolean }

const DRAG_TYPE = 'application/x-iskra-organize'

const More = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
)

const FolderPlus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M12 10v6M9 13h6" />
  </svg>
)

/** Where a pointer menu opens: at the pointer for right clicks, under the button otherwise. */
function anchorOf(e: MouseEvent<HTMLElement>): MenuAnchor {
  if (e.type === 'contextmenu') return { x: e.clientX, y: e.clientY }
  const rect = e.currentTarget.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom + 4 }
}

export function ChannelList({ server, isAdmin, onNavigate, onCreateChannel }: {
  server: ServerState
  isAdmin: boolean
  onNavigate: () => void
  /** Opens the create-channel dialog, optionally inside a category. */
  onCreateChannel: (categoryId: number | null) => void
}) {
  const { t } = useTranslation()
  const categories = useCategories(server.key)
  const collapsed = useOrganize((s) => s.collapsed[server.key]) ?? []
  const activeId = useApp(activeChannelId)
  const voiceSession = useVoice((s) => s.session)
  const layout = layoutChannels(server.channels, categories)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  const [menu, setMenu] = useState<{ kind: 'channel' | 'category'; id: number; anchor: MenuAnchor | null } | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'edit'; channel: Channel } | { kind: 'category'; category?: Category } | null>(null)

  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  const canDrag = isAdmin && !touch

  const openMenu = (kind: 'channel' | 'category', id: number) => (e: MouseEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ kind, id, anchor: anchorOf(e) })
  }

  /** The context-menu key (or Shift+F10) on a row: its menu, under the row. */
  const menuKey = (kind: 'channel' | 'category', id: number) => (e: KeyboardEvent<HTMLElement>) => {
    if (!isMenuKey(e)) return
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    setMenu({ kind, id, anchor: { x: rect.left + 8, y: rect.bottom + 4 } })
  }

  const endDrag = () => {
    setDrag(null)
    setOver(null)
  }

  /** Drag-and-drop handlers for a drop target; `accept` says whether the current drag may land here. */
  const target = (where: Over, accept: (d: Drag) => boolean, drop: (d: Drag, after: boolean) => void) => canDrag ? {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag || !accept(drag)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = e.currentTarget.getBoundingClientRect()
      const after = e.clientY > rect.top + rect.height / 2
      if (over?.kind !== where.kind || over.id !== where.id || over.after !== after) setOver({ ...where, after })
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o?.kind === where.kind && o.id === where.id ? null : o))
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!drag || !accept(drag)) return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      drop(drag, e.clientY > rect.top + rect.height / 2)
      endDrag()
    },
  } : {}

  const source = (d: Drag) => canDrag ? {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(DRAG_TYPE, `${d.kind}:${d.id}`)
      e.dataTransfer.setData('text/plain', '')
      setDrag(d)
    },
    onDragEnd: endDrag,
  } : {}

  const onChannelDrop = (channel: Channel) => (d: Drag, after: boolean) => {
    const move = dropOnChannel(layout, d.id, channel, after)
    if (move) void moveChannel(server.key, d.id, move.categoryId, move.before).catch(() => undefined)
  }

  const rowProps = (channel: Channel) => ({
    ...source({ kind: 'channel', id: channel.id }),
    ...target({ kind: 'channel', id: channel.id }, (d) => d.kind === 'channel', onChannelDrop(channel)),
    onContextMenu: openMenu('channel', channel.id),
    onKeyDown: menuKey('channel', channel.id),
    className: `org-row ${drag?.kind === 'channel' && drag.id === channel.id ? 'dragging' : ''} ${
      over?.kind === 'channel' && over.id === channel.id ? (over.after ? 'drop-after' : 'drop-before') : ''}`,
  })

  const renderChannel = (channel: Channel) => channel.kind === 'stage'
    ? <StageRow key={channel.id} server={server} channel={channel} rowProps={rowProps(channel)} onMenu={openMenu('channel', channel.id)} onNavigate={onNavigate} />
    : channel.kind === 'voice'
    ? <VoiceRow key={channel.id} server={server} channel={channel} rowProps={rowProps(channel)} onMenu={openMenu('channel', channel.id)} onNavigate={onNavigate} />
    : <TextRow key={channel.id} server={server} channel={channel} active={channel.id === activeId} rowProps={rowProps(channel)} onMenu={openMenu('channel', channel.id)} onNavigate={onNavigate} />

  const topText = layout.uncategorized.filter((c) => !isVoiceLike(c))
  const topVoice = layout.uncategorized.filter(isVoiceLike)
  // Everything sits in categories (e.g. a new server from a template): no empty "Text"/"Voice" headings above them.
  // The admin's "Create category" moves to the first category's heading; the top row shows up only as a drop target
  // while a channel is being dragged out of its category.
  const bare = topText.length === 0 && topVoice.length === 0 && layout.groups.length > 0
  const createCategoryButton = (
    <button className="icon-button small" onClick={() => setDialog({ kind: 'category' })} aria-label={t('organize.list.createCategory')} title={t('organize.list.createCategory')}>
      <FolderPlus />
    </button>
  )
  const toTop = (d: Drag) => void moveChannel(server.key, d.id, null, null).catch(() => undefined)
  const menuChannel = menu?.kind === 'channel' ? server.channels.find((c) => c.id === menu.id) : undefined
  const menuCategory = menu?.kind === 'category' ? categories.find((c) => c.id === menu.id) : undefined

  return (
    <>
      <StartHereEntry server={server} onNavigate={onNavigate} />
      {(topText.length > 0 || (isAdmin && (!bare || drag?.kind === 'channel'))) && (
        <div className={`channel-group ${over?.kind === 'top' && over.id === 0 ? 'drop-into' : ''}`}
          {...target({ kind: 'top', id: 0 }, (d) => d.kind === 'channel', toTop)}>
          <span>{t('organize.list.text')}</span>
          {isAdmin && !bare && (
            <span className="org-group-actions">
              {createCategoryButton}
              <button className="icon-button small" onClick={() => onCreateChannel(null)} aria-label={t('organize.list.createChannel')} title={t('organize.list.createChannel')}>
                <Plus size={14} />
              </button>
            </span>
          )}
        </div>
      )}
      {topText.map(renderChannel)}
      {(topVoice.length > 0 || (isAdmin && !bare)) && (
        <div className={`channel-group ${over?.kind === 'top' && over.id === 1 ? 'drop-into' : ''}`}
          {...target({ kind: 'top', id: 1 }, (d) => d.kind === 'channel', toTop)}>
          <span>{t('organize.list.voice')}</span>
          {isAdmin && (
            <button className="icon-button small" onClick={() => onCreateChannel(null)} aria-label={t('organize.list.createVoice')} title={t('organize.list.createChannel')}>
              <Plus size={14} />
            </button>
          )}
        </div>
      )}
      {topVoice.map(renderChannel)}

      {layout.groups.map(({ category, channels }, index) => {
        // Only admins see categories with nothing in them (the server leaves out the ones you can't see into).
        if (channels.length === 0 && !isAdmin) return null
        const isCollapsed = collapsed.includes(category.id)
        const shown = isCollapsed
          ? channels.filter((c) => c.id === activeId || (voiceSession?.serverKey === server.key && voiceSession.channelId === c.id))
          : channels
        return (
          <section key={category.id} className="org-category" aria-label={category.name}>
            <div
              {...source({ kind: 'category', id: category.id })}
              {...target({ kind: 'category', id: category.id }, () => true, (d) => {
                if (d.kind === 'channel') {
                  void moveChannel(server.key, d.id, category.id, null).catch(() => undefined)
                  return
                }
                const move = dropOnCategory(categories, d.id, category.id)
                if (move) void moveCategory(server.key, d.id, move.before).catch(() => undefined)
              })}
              onContextMenu={openMenu('category', category.id)}
              onKeyDown={menuKey('category', category.id)}
              className={`channel-group org-category-head ${over?.kind === 'category' && over.id === category.id ? (drag?.kind === 'category' ? 'drop-before' : 'drop-into') : ''} ${drag?.kind === 'category' && drag.id === category.id ? 'dragging' : ''}`}
            >
              <button className="org-category-toggle" aria-expanded={!isCollapsed} onClick={() => toggleCollapsed(server.key, category.id)}>
                <span className={`org-chevron ${isCollapsed ? 'collapsed' : ''}`}><ChevronDown size={12} /></span>
                <span className="org-category-name">{category.name}</span>
              </button>
              <span className="org-group-actions">
                {isAdmin && bare && index === 0 && createCategoryButton}
                {isAdmin && (
                  <button className="icon-button small" onClick={() => onCreateChannel(category.id)} aria-label={t('organize.list.createIn', { category: category.name })} title={t('organize.list.createChannel')}>
                    <Plus size={14} />
                  </button>
                )}
                <button className="icon-button small org-more" onClick={openMenu('category', category.id)} aria-label={t('organize.list.options', { name: category.name })} title={t('organize.list.categoryOptions')}>
                  <More />
                </button>
              </span>
            </div>
            {shown.map(renderChannel)}
            {isAdmin && channels.length === 0 && !isCollapsed && <p className="org-empty">{t('organize.list.dragHere')}</p>}
          </section>
        )
      })}

      {menuChannel && (
        <ChannelMenu server={server} channel={menuChannel} anchor={menu!.anchor} isAdmin={isAdmin}
          onEdit={() => setDialog({ kind: 'edit', channel: menuChannel })} onClose={() => setMenu(null)} />
      )}
      {menuCategory && (
        <CategoryMenu server={server} category={menuCategory} anchor={menu!.anchor} isAdmin={isAdmin}
          onCreateChannel={() => onCreateChannel(menuCategory.id)} onRename={() => setDialog({ kind: 'category', category: menuCategory })}
          onClose={() => setMenu(null)} />
      )}
      {dialog?.kind === 'category' && <CategoryDialog server={server} category={dialog.category} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <ChannelSettingsDialog server={server} channel={dialog.channel} onClose={() => setDialog(null)} />}
    </>
  )
}

type RowProps = HTMLAttributes<HTMLDivElement>

function TextRow({ server, channel, active, rowProps, onMenu, onNavigate }: {
  server: ServerState; channel: Channel; active: boolean; rowProps: RowProps; onMenu: (e: MouseEvent<HTMLElement>) => void; onNavigate: () => void
}) {
  const { t } = useTranslation()
  const notify = useNotifyFor(server.key, channel.id)
  const counts = useChannelCounts(server.key, channel)
  const shown = channelBadges(counts.unread, counts.mentions, notify)
  return (
    <div {...rowProps}>
      <button
        className={`channel ${active ? 'active' : ''} ${shown.unread ? 'unread' : ''} ${shown.dimmed ? 'muted' : ''}`}
        onClick={() => {
          setStageOpen(false) // first: leaving the call screen for chat must never depend on the rest
          selectChannel(server.key, channel.id)
          onNavigate()
        }}
      >
        <span className="hash"><ChannelKindIcon kind={channel.kind} /></span>
        <span className="channel-name">{channel.name}</span>
        {channel.e2ee ? <LockBadge channel={channel} />
          : channel.readRole !== 'member' && channel.readRole !== 'guest' && <span className="lock" title={t('organize.list.only', { role: levelName(channel.readRole) })}><Lock size={12} /></span>}
        {shown.pings > 0 && !active && <span className="badge" title={t('organize.list.mentions')}>{shown.pings}</span>}
      </button>
      <button className="icon-button small org-more" onClick={onMenu} aria-label={t('organize.list.options', { name: `#${channel.name}` })} title={t('organize.list.channelOptions')}>
        <More />
      </button>
    </div>
  )
}

function VoiceRow({ server, channel, rowProps, onMenu, onNavigate }: {
  server: ServerState; channel: Channel; rowProps: RowProps; onMenu: (e: MouseEvent<HTMLElement>) => void; onNavigate: () => void
}) {
  const { t } = useTranslation()
  const voiceSession = useVoice((s) => s.session)
  const speaking = useVoice((s) => s.speaking)
  const participants = server.voice[channel.id] ?? []
  const here = voiceSession?.serverKey === server.key && voiceSession.channelId === channel.id
  const mustAgree = useMustAgree(server.key)
  const bypass = has(server.me, useServerRoles(server.key), 'moveMembers')
  const limit = limitLabel(participants.length, channel.userLimit)
  const full = !here && isFull(participants.length, channel.userLimit, bypass)
  const afk = useAfkChannel(server.key) === channel.id
  return (
    <div className="voice-channel">
      <div {...rowProps}>
        <button
          className={`channel ${here ? 'active' : ''}`}
          disabled={!server.voiceAvailable}
          title={!server.voiceAvailable ? t('organize.list.voiceUnavailable') : full ? t('organize.list.full', { name: channel.name }) : t('organize.list.join', { name: channel.name })}
          onClick={() => {
            if (mustAgree) return showRules(server.key)
            void joinVoice(server.key, channel.id)
            onNavigate()
          }}
        >
          <span className="hash"><Volume size={16} /></span>
          <span className="channel-name">{channel.name}</span>
          <LockBadge channel={channel} />
          {afk && <span className="afk-badge" title={t('afk.channelHint')}>{t('afk.badge')}</span>}
          {here && voiceSession.state !== 'connected' && <span className="pill">…</span>}
          {limit && (
            <span className={`voice-limit ${full ? 'full' : ''}`} aria-label={t(full ? 'organize.list.countFull' : 'organize.list.count', { people: participants.length, limit: channel.userLimit ?? 0 })}>{limit}</span>
          )}
        </button>
        <VoiceChatRowButton server={server} channel={channel} onNavigate={onNavigate} />
        <button className="icon-button small org-more" onClick={onMenu} aria-label={t('organize.list.options', { name: channel.name })} title={t('organize.list.channelOptions')}>
          <More />
        </button>
      </div>
      {participants.length > 0 && (
        <ul className="voice-participants">
          {participants.map((p) => {
            const member = server.members[p.accountKey]
            const isMe = p.accountKey === server.me?.accountKey
            return (
              <li
                key={p.accountKey}
                className={`${here && speaking[p.accountKey] ? 'speaking' : ''} ${isMe ? 'me' : ''}`}
                {...userMenuProps(p.accountKey, server.key)}
              >
                <button className="participant" onClick={(e) => openProfileCard(server.key, p.accountKey, e.currentTarget)}>
                  <Avatar name={member?.name ?? '?'} accountKey={p.accountKey} size={22} />
                  <span className="member-name">{member?.name ?? t('common.someone')}</span>
                  {member?.bot && <BotBadge />}
                  <ClipsMark on={p.clips} />
                </button>
                {p.afk ? <span className="voice-flag server-muted" title={t('afk.participantForced')}><HeadphonesOff size={14} /></span> : p.serverMuted ? <span className="voice-flag server-muted" title={t('organize.list.serverMuted')}><MicOff size={14} /></span> : p.deafened ? <span className="voice-flag" title={t('organize.list.deafened')}><HeadphonesOff size={14} /></span> : p.muted ? <span className="voice-flag" title={t('organize.list.muted')}><MicOff size={14} /></span> : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function StageRow({ server, channel, rowProps, onMenu, onNavigate }: {
  server: ServerState; channel: Channel; rowProps: RowProps; onMenu: (e: MouseEvent<HTMLElement>) => void; onNavigate: () => void
}) {
  const { t } = useTranslation()
  return (
    <div {...rowProps}>
      <StageEntry server={server} channelId={channel.id} name={channel.name} onNavigate={onNavigate} />
      <VoiceChatRowButton server={server} channel={channel} onNavigate={onNavigate} />
      <button className="icon-button small org-more" onClick={onMenu} aria-label={t('organize.list.options', { name: channel.name })} title={t('organize.list.channelOptions')}>
        <More />
      </button>
    </div>
  )
}
