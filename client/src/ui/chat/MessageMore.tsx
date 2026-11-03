// Everything you can do with a message, in one menu: the "⋯" on its hover bar (a popover on desktop) and press and
// hold on phones (a sheet, with a row of quick reactions on top). Grouped: respond · keep · read · manage. Also the
// reactions list ("View reactions") and the delete confirmation.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { messageLink } from '../../core/pushRoute'
import type { Message } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { connectionFor, toggleReaction, type PendingMessage, type ServerState } from '../../state/store'
import { markUnread } from '../../state/unread'
import { canReport, openReport } from '../../state/reports'
import { startSelecting } from '../../state/modpack'
import { has } from '../../state/permissions'
import { rolesFor } from '../../state/roles'
import { setPinned } from '../../state/pins'
import { Avatar, Modal } from '../bits'
import { appUrl } from '../format'
import { EmojiGlyph, EmojiPicker } from '../expressions/EmojiPicker'
import { SmilePlus } from '../expressions/icons'
import { Copy, Flag, Link, ListChecks, MessageDot, MoreHorizontal, Pencil, Reply, Trash } from '../icons'
import { Menu, MenuGroup, MenuItem, type MenuAnchor } from '../kit'
import { ForwardIcon } from '../organize/ForwardDialog'
import { plainText } from '../markdown'
import { ChannelSaveRemind, flashDone } from '../productivity/MessageTools'
import { TranslateMenuItem } from '../translate/Translate'
import { channelItem } from '../translate/items'
import { ReadAloudMenuItem } from '../speech/ReadAloud'
import { PinIcon, PinOffIcon, ThreadIcon } from './extraIcons'
import { QUICK_REACTIONS, setReply } from './helpers'
import { NewThreadDialog } from './PinThreadBits'
import { pinThreadAbilities } from './abilities'
import './more.css'

/** Where links to this server's messages should open: its web app, or this page if it's a web page (not app:// or capacitor://). */
export function linkTo(server: ServerState, message: Message): string {
  const base = appUrl(server.appUrl)
  return messageLink(base, server.key, message.channelId, message.id)
}

export async function copyMessageLink(server: ServerState, message: Message): Promise<void> {
  await navigator.clipboard.writeText(linkTo(server, message))
}

export interface MessageMenuProps {
  server: ServerState
  message: PendingMessage
  canEdit: boolean
  canDelete: boolean
  onEdit: () => void
  onForward?: () => void
}

/** The "⋯" on a message's hover bar. Reply, edit, thread and pin sit on the bar itself, so the menu leaves them out. */
export function MessageMoreButton(props: MessageMenuProps) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const { t } = useTranslation()
  if (props.message.tempId) return null
  return (
    <>
      <button
        onClick={(e) => {
          if (anchor) return setAnchor(null)
          const r = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: r.right, y: r.bottom + 4 })
        }}
        title={t('common.more')} aria-label={t('common.more')} aria-haspopup="menu" aria-expanded={!!anchor}
      >
        <MoreHorizontal size={15} />
      </button>
      {anchor && <MessageMenu {...props} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  )
}

type View = 'menu' | 'emoji' | 'thread' | 'delete' | 'reactions'

/** `anchor` null: the press-and-hold sheet, with quick reactions and every action. */
export function MessageMenu({ server, message, canEdit, canDelete, onEdit, onForward, anchor, onClose }: MessageMenuProps & {
  anchor: MenuAnchor | null
  onClose: () => void
}) {
  const [view, setView] = useState<View>('menu')
  const [error, setError] = useState<string | null>(null)
  const { t } = useTranslation()
  const full = anchor === null
  const { pinnable, threadable } = pinThreadAbilities(server, message)
  const text = plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null })
  const live = !message.tempId
  const canSelect = has(server.me, rolesFor(server.key), 'manageMessages')
  const reportable = canReport(server, message)

  const wrap = (label: string | null, action: () => unknown) => async () => {
    try {
      await action()
      onClose()
      if (label) flashDone(label)
    } catch (e) {
      setError(errorMessage(e) || t('chat.actions.failed'))
    }
  }

  if (view === 'emoji') {
    return <EmojiPicker serverKey={server.key} anchor={null} onClose={onClose} onPick={(emoji) => toggleReaction(server.key, message, emoji)} />
  }
  if (view === 'reactions') return <ReactionsDialog server={server} message={message} onClose={onClose} />
  if (view === 'thread') return createPortal(<NewThreadDialog server={server} message={message} onClose={onClose} />, document.body)
  if (view === 'delete') return <DeleteMessageDialog server={server} message={message} onClose={onClose} />

  return (
    <Menu anchor={anchor} label={t('chat.actions.label')} onClose={onClose}>
      {full && (
        <div className="sheet-reactions" role="group" aria-label={t('chat.actions.react')}>
          {QUICK_REACTIONS.slice(0, 6).map((emoji) => (
            <button key={emoji} aria-label={t('chat.actions.reactWith', { emoji })} onClick={wrap(null, () => toggleReaction(server.key, message, emoji))}>{emoji}</button>
          ))}
          <button aria-label={t('chat.reactions.moreEmoji')} onClick={() => setView('emoji')}><SmilePlus size={20} /></button>
        </div>
      )}
      <div className="org-list message-menu" role="menu" aria-label={t('chat.actions.options')}>
        {full ? (
          <MenuGroup>
            <MenuItem icon={<Reply />} onClick={wrap(null, () => setReply(server.key, message.channelId, message))}>{t('chat.message.reply')}</MenuItem>
            {threadable && <MenuItem icon={<ThreadIcon />} onClick={() => setView('thread')}>{t('chat.threads.start')}</MenuItem>}
            {onForward && <MenuItem icon={<ForwardIcon />} onClick={wrap(null, onForward)}>{t('chat.message.forward')}</MenuItem>}
            {pinnable && (
              <MenuItem icon={message.pinned ? <PinOffIcon /> : <PinIcon />} onClick={wrap(null, () => setPinned(server.key, message, !message.pinned))}>
                {message.pinned ? t('chat.pins.unpinMessage') : t('chat.pins.pinMessage')}
              </MenuItem>
            )}
            {canEdit && <MenuItem icon={<Pencil />} onClick={wrap(null, onEdit)}>{t('chat.actions.editMessage')}</MenuItem>}
          </MenuGroup>
        ) : onForward && (
          <MenuGroup>
            <MenuItem icon={<ForwardIcon />} onClick={wrap(null, onForward)}>{t('chat.message.forward')}</MenuItem>
          </MenuGroup>
        )}
        <MenuGroup>
          {text && <MenuItem icon={<Copy />} onClick={wrap(t('chat.actions.textCopied'), () => navigator.clipboard.writeText(text))}>{t('chat.actions.copyText')}</MenuItem>}
          {live && <MenuItem icon={<Link />} onClick={wrap(t('chat.actions.linkCopied'), () => copyMessageLink(server, message))}>{t('chat.actions.copyLink')}</MenuItem>}
          {live && <ChannelSaveRemind server={server} message={message} wrap={wrap} />}
          {live && <MenuItem icon={<MessageDot />} onClick={wrap(null, () => markUnread(server.key, message.channelId, message.id))}>{t('chat.actions.markUnread')}</MenuItem>}
        </MenuGroup>
        {live && (
          <MenuGroup>
            <TranslateMenuItem item={channelItem(server, message)} wrap={wrap} />
            <ReadAloudMenuItem server={server} message={message} wrap={wrap} />
            {message.reactions.length > 0 && <MenuItem icon={<SmilePlus />} onClick={() => setView('reactions')}>{t('chat.actions.viewReactions')}</MenuItem>}
          </MenuGroup>
        )}
        {live && (canSelect || reportable || canDelete) && (
          <MenuGroup>
            {canSelect && <MenuItem icon={<ListChecks />} onClick={wrap(null, () => startSelecting(server.key, message.channelId, message.id))}>{t('chat.actions.selectMessages')}</MenuItem>}
            {reportable && <MenuItem icon={<Flag />} danger onClick={wrap(null, () => openReport({ kind: 'message', serverKey: server.key, message }))}>{t('safety.report.menuMessage')}</MenuItem>}
            {canDelete && <MenuItem icon={<Trash />} danger onClick={() => setView('delete')}>{t('chat.actions.deleteMessage')}</MenuItem>}
          </MenuGroup>
        )}
      </div>
      {error && <p className="error-text sheet-error" role="alert">{error}</p>}
    </Menu>
  )
}

/** "Delete this message?" with the message itself quoted, so it's clear which one. */
export function DeleteMessageDialog({ server, message, onClose }: { server: ServerState; message: Message; onClose: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const text = plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null })
  async function remove() {
    setBusy(true)
    try {
      await connectionFor(server.key)?.request('chat.delete', { id: message.id })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Modal title={t('chat.actions.deleteTitle')} onClose={onClose} className="delete-message-dialog" footer={(
      <>
        <button className="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="button danger" onClick={() => void remove()} disabled={busy}>{t('common.delete')}</button>
      </>
    )}>
      <p className="muted">{t('chat.actions.cannotUndo')}</p>
      {text && <blockquote className="delete-message-quote">{text}</blockquote>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}

/** Who reacted with what: one tab per emoji. */
export function ReactionsDialog({ server, message, initial, onClose }: { server: ServerState; message: Message; initial?: string; onClose: () => void }) {
  const [emoji, setEmoji] = useState(initial ?? message.reactions[0]?.emoji)
  const current = message.reactions.find((r) => r.emoji === emoji) ?? message.reactions[0]
  const { t } = useTranslation()
  return (
    <Modal title={t('chat.reactions.dialogTitle')} onClose={onClose}>
      <div className="reactions-dialog">
        <div className="reaction-tabs" role="tablist" aria-label={t('chat.composer.emoji')}>
          {message.reactions.map((r) => (
            <button key={r.emoji} role="tab" aria-selected={r === current} className={r === current ? 'active' : ''} onClick={() => setEmoji(r.emoji)}>
              <EmojiGlyph serverKey={server.key} emoji={r.emoji} /> <span>{r.accounts.length}</span>
            </button>
          ))}
        </div>
        <ul className="reaction-people" role="tabpanel">
          {current?.accounts.map((key) => {
            const name = server.members[key]?.name ?? t('chat.reactions.someoneWhoLeft')
            return (
              <li key={key}>
                <Avatar name={name} accountKey={key} size={28} />
                <span>{name}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}
