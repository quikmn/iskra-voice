// Phones: everything you can do with a message, in a sheet from the bottom (opened by pressing and holding).
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const { pinnable, threadable } = pinThreadAbilities(server, message)
  useEscapeLayer(onClose, view === 'menu' || view === 'delete')
  useFocusTrap(ref)

  const run = (action: () => void | Promise<unknown>) => async () => {
    try {
      await action()
      onClose()
    } catch (e) {
      setError((e as Error).message)
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
      <div className="action-sheet" role="dialog" aria-label="Message actions" ref={ref} tabIndex={-1}>
        <span className="sheet-grabber" aria-hidden />
        {view === 'delete' ? (
          <div className="sheet-confirm">
            <strong>Delete this message?</strong>
            <p className="muted">This can't be undone.</p>
            <button className="button danger wide" onClick={run(() => connectionFor(server.key)?.request('chat.delete', { id: message.id }))}>Delete</button>
            <button className="button wide" onClick={() => setView('menu')}>Cancel</button>
          </div>
        ) : (
          <>
            <div className="sheet-reactions" role="group" aria-label="React">
              {QUICK_REACTIONS.slice(0, 6).map((emoji) => (
                <button key={emoji} aria-label={`React with ${emoji}`} onClick={run(() => toggleReaction(server.key, message, emoji))}>{emoji}</button>
              ))}
              <button aria-label="More emoji" onClick={() => setView('emoji')}><SmilePlus size={20} /></button>
            </div>
            <div className="sheet-list" role="menu">
              <button role="menuitem" onClick={run(() => setReply(server.key, message.channelId, message))}><Reply /> Reply</button>
              {threadable && <button role="menuitem" onClick={() => setView('thread')}><ThreadIcon /> Start a thread</button>}
              {pinnable && (
                <button role="menuitem" onClick={run(() => setPinned(server.key, message, !message.pinned))}>
                  {message.pinned ? <><PinOffIcon /> Unpin message</> : <><PinIcon /> Pin message</>}
                </button>
              )}
              {onForward && <button role="menuitem" onClick={run(onForward)}><ForwardIcon /> Forward</button>}
              {canEdit && <button role="menuitem" onClick={run(onEdit)}><Pencil /> Edit message</button>}
              {text && <button role="menuitem" onClick={run(() => navigator.clipboard.writeText(text))}><Copy /> Copy text</button>}
              <button role="menuitem" onClick={run(() => copyMessageLink(server, message))}><Copy /> Copy message link</button>
              <button role="menuitem" onClick={run(() => markUnread(server.key, message.channelId, message.id))}><Reply /> Mark unread</button>
              {message.reactions.length > 0 && <button role="menuitem" onClick={() => setView('reactions')}><SmilePlus /> View reactions</button>}
              {canDelete && <button role="menuitem" className="danger" onClick={() => setView('delete')}><Trash /> Delete message</button>}
            </div>
          </>
        )}
        {error && <p className="error-text sheet-error" role="alert">{error}</p>}
      </div>
    </div>,
    document.body,
  )
}
