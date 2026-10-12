// The "More" menu on a message (copy link, copy text, mark unread, who reacted) and the reactions list.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { messageLink } from '../../core/pushRoute'
import type { Message } from '../../core/protocol'
import type { PendingMessage, ServerState } from '../../state/store'
import { markUnread } from '../../state/unread'
import { canReport, openReport } from '../../state/reports'
import { Avatar, Modal } from '../bits'
import { appUrl } from '../format'
import { EmojiGlyph } from '../expressions/EmojiPicker'
import { usePopoverPosition } from '../expressions/popover'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { focusFirstItem } from '../a11y'
import { plainText } from '../markdown'
import { ChannelSaveRemind } from '../productivity/MessageTools'
import './more.css'

/** Where links to this server's messages should open: its web app, or this page if it's a web page (not app:// or capacitor://). */
export function linkTo(server: ServerState, message: Message): string {
  const base = appUrl(server.appUrl)
  return messageLink(base, server.key, message.channelId, message.id)
}

export async function copyMessageLink(server: ServerState, message: Message): Promise<void> {
  await navigator.clipboard.writeText(linkTo(server, message))
}

const MoreIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden><circle cx="5" cy="12" r="2" fill="currentColor" /><circle cx="12" cy="12" r="2" fill="currentColor" /><circle cx="19" cy="12" r="2" fill="currentColor" /></svg>
)

export function MessageMoreButton({ server, message }: { server: ServerState; message: PendingMessage }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [reactions, setReactions] = useState(false)
  const { t } = useTranslation()
  if (message.tempId) return null
  return (
    <>
      <button onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} title={t('common.more')} aria-label={t('common.more')} aria-haspopup="menu" aria-expanded={!!anchor}>
        <MoreIcon />
      </button>
      {anchor && <MoreMenu server={server} message={message} anchor={anchor} onClose={() => setAnchor(null)} onReactions={() => setReactions(true)} />}
      {reactions && <ReactionsDialog server={server} message={message} onClose={() => setReactions(false)} />}
    </>
  )
}

function MoreMenu({ server, message, anchor, onClose, onReactions }: {
  server: ServerState; message: Message; anchor: HTMLElement; onClose: () => void; onReactions: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { style } = usePopoverPosition(anchor, ref)
  const [done, setDone] = useState<string | null>(null)
  const { t } = useTranslation()
  useEscapeLayer(onClose)
  useFocusTrap(ref)
  useEffect(() => focusFirstItem(ref.current), [])
  const text = plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null })
  const act = (label: string | null, action: () => unknown) => async () => {
    try {
      await action()
      if (label) {
        setDone(label)
        setTimeout(onClose, 700)
      } else onClose()
    } catch {
      setDone(t('chat.actions.failed'))
    }
  }
  return createPortal(
    <div className="more-menu-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="more-menu" style={style} role="menu" aria-label={t('chat.actions.options')} tabIndex={-1}>
        {done ? <div className="more-done" role="status">{done}</div> : (
          <>
            <button role="menuitem" onClick={act(t('chat.actions.linkCopied'), () => copyMessageLink(server, message))}>{t('chat.actions.copyLink')}</button>
            {text && <button role="menuitem" onClick={act(t('chat.actions.textCopied'), () => navigator.clipboard.writeText(text))}>{t('chat.actions.copyText')}</button>}
            <button role="menuitem" onClick={act(null, () => markUnread(server.key, message.channelId, message.id))}>{t('chat.actions.markUnread')}</button>
            <ChannelSaveRemind server={server} message={message} wrap={act} />
            {message.reactions.length > 0 && <button role="menuitem" onClick={act(null, onReactions)}>{t('chat.actions.viewReactions')}</button>}
            {canReport(server, message) && (
              <button role="menuitem" className="danger" onClick={act(null, () => openReport({ kind: 'message', serverKey: server.key, message }))}>{t('safety.report.menuMessage')}</button>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
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
