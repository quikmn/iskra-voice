// Phones: everything you can do with a message, in a sheet from the bottom (opened by pressing and holding).
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { connectionFor, toggleReaction, type PendingMessage, type ServerState } from '../../state/store'
import { setPinned } from '../../state/pins'
import { useFocusTrap } from '../layers'
import { EmojiPicker } from '../expressions/EmojiPicker'
import { SmilePlus } from '../expressions/icons'
import { Copy, Pencil, Reply, Trash } from '../icons'
import { ForwardIcon } from '../organize/ForwardDialog'
import { useEscapeLayer } from '../layers'
import { plainText } from '../markdown'
import { PinIcon, PinOffIcon, ThreadIcon } from './extraIcons'
import { QUICK_REACTIONS, setReply } from './helpers'
import { NewThreadDialog } from './PinThreadBits'
import { pinThreadAbilities } from './abilities'
import { copyMessageLink, ReactionsDialog } from './MessageMore'
import { markUnread } from '../../state/unread'
import { canReport, openReport } from '../../state/reports'

const FlagIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 22V4c4-2 8 2 12 0s4 0 4 0v10c-4 2-8-2-12 0s-4 0-4 0" />
  </svg>
)

export function MessageActionSheet({ server, message, canEdit, canDelete, onEdit, onClose, onForward }: {
  server: ServerState
  message: PendingMessage
  canEdit: boolean
  canDelete: boolean
  onEdit: () => void
  onClose: () => void
  onForward?: () => void
}) {
  const [view, setView] = useState<'menu' | 'emoji' | 'thread' | 'delete' | 'reactions'>('menu')
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()
  const { pinnable, threadable } = pinThreadAbilities(server, message)
  useEscapeLayer(onClose, view === 'menu' || view === 'delete')
  useFocusTrap(ref)

  const run = (action: () => void | Promise<unknown>) => async () => {
    try {
      await action()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (view === 'emoji') {
    return <EmojiPicker serverKey={server.key} anchor={null} onClose={onClose} onPick={(emoji) => toggleReaction(server.key, message, emoji)} />
  }
  if (view === 'reactions') return <ReactionsDialog server={server} message={message} onClose={onClose} />
  if (view === 'thread') return createPortal(<NewThreadDialog server={server} message={message} onClose={onClose} />, document.body)

  const text = plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null })
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="action-sheet" role="dialog" aria-label={t('chat.actions.label')} ref={ref} tabIndex={-1}>
        <span className="sheet-grabber" aria-hidden />
        {view === 'delete' ? (
          <div className="sheet-confirm">
            <strong>{t('chat.actions.deleteTitle')}</strong>
            <p className="muted">{t('chat.actions.cannotUndo')}</p>
            <button className="button danger wide" onClick={run(() => connectionFor(server.key)?.request('chat.delete', { id: message.id }))}>{t('common.delete')}</button>
            <button className="button wide" onClick={() => setView('menu')}>{t('common.cancel')}</button>
          </div>
        ) : (
          <>
            <div className="sheet-reactions" role="group" aria-label={t('chat.actions.react')}>
              {QUICK_REACTIONS.slice(0, 6).map((emoji) => (
                <button key={emoji} aria-label={t('chat.actions.reactWith', { emoji })} onClick={run(() => toggleReaction(server.key, message, emoji))}>{emoji}</button>
              ))}
              <button aria-label={t('chat.reactions.moreEmoji')} onClick={() => setView('emoji')}><SmilePlus size={20} /></button>
            </div>
            <div className="sheet-list" role="menu">
              <button role="menuitem" onClick={run(() => setReply(server.key, message.channelId, message))}><Reply /> {t('chat.message.reply')}</button>
              {threadable && <button role="menuitem" onClick={() => setView('thread')}><ThreadIcon /> {t('chat.threads.start')}</button>}
              {pinnable && (
                <button role="menuitem" onClick={run(() => setPinned(server.key, message, !message.pinned))}>
                  {message.pinned ? <><PinOffIcon /> {t('chat.pins.unpinMessage')}</> : <><PinIcon /> {t('chat.pins.pinMessage')}</>}
                </button>
              )}
              {onForward && <button role="menuitem" onClick={run(onForward)}><ForwardIcon /> {t('chat.message.forward')}</button>}
              {canEdit && <button role="menuitem" onClick={run(onEdit)}><Pencil /> {t('chat.actions.editMessage')}</button>}
              {text && <button role="menuitem" onClick={run(() => navigator.clipboard.writeText(text))}><Copy /> {t('chat.actions.copyText')}</button>}
              <button role="menuitem" onClick={run(() => copyMessageLink(server, message))}><Copy /> {t('chat.actions.copyLink')}</button>
              <button role="menuitem" onClick={run(() => markUnread(server.key, message.channelId, message.id))}><Reply /> {t('chat.actions.markUnread')}</button>
              {message.reactions.length > 0 && <button role="menuitem" onClick={() => setView('reactions')}><SmilePlus /> {t('chat.actions.viewReactions')}</button>}
              {canReport(server, message) && (
                <button role="menuitem" className="danger" onClick={run(() => openReport({ kind: 'message', serverKey: server.key, message }))}><FlagIcon /> {t('safety.report.menuMessage')}</button>
              )}
              {canDelete && <button role="menuitem" className="danger" onClick={() => setView('delete')}><Trash /> {t('chat.actions.deleteMessage')}</button>}
            </div>
          </>
        )}
        {error && <p className="error-text sheet-error" role="alert">{error}</p>}
      </div>
    </div>,
    document.body,
  )
}
