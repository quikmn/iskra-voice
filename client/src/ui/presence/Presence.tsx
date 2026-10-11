// Status pieces: the custom status line, the "you" button in the me bar with its status menu, and the custom status dialog.
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ChosenStatus, CustomStatus } from '../../core/protocol'
import { myShownStatus, setCustomStatus, setStatus, useAccountPresence, usePresence } from '../../state/presence'
import {
  CLEAR_AFTER, MAX_STATUS_TEXT, STATUS_HINTS, STATUS_LABELS, activeCustom, cleanCustom, clearsIn, expiryFor, type ClearAfter,
} from '../../state/presenceRules'
import { Avatar, Modal } from '../bits'
import { EmojiPicker } from '../expressions/EmojiPicker'
import { usePopoverPosition } from '../expressions/popover'
import { Close, Smile } from '../icons'
import { useEscapeLayer, useFocusTrap } from '../layers'
import './presence.css'

/** "🎮 Raiding tonight": emoji and text, rendered by React. */
export function CustomStatusLine({ custom, className }: { custom: CustomStatus | null; className?: string }) {
  if (!custom) return null
  return (
    <span className={`custom-status ${className ?? ''}`} title={custom.text ?? undefined}>
      {custom.emoji && <span className="custom-status-emoji">{custom.emoji}</span>}
      {custom.text && <span className="custom-status-text">{custom.text}</span>}
    </span>
  )
}

/** Avatar, name and status in the me bar; opens the status menu. */
export function MeStatusButton({ name, accountKey, sub, speaking = false, flag = null, title }: {
  name: string; accountKey: string; sub: ReactNode
  /** Voice: a ring while you talk, and a muted/deafened mark. */
  speaking?: boolean; flag?: ReactNode; title?: string
}) {
  const { t } = useTranslation()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [editing, setEditing] = useState(false)
  const state = usePresence()
  const status = myShownStatus(state)
  const custom = activeCustom(state.mine.custom)
  return (
    <>
      <button
        className="me-status-button"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        aria-label={t('presence.setStatus', { status: STATUS_LABELS[status] })}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
      >
        <span className={`me-avatar ${speaking ? 'speaking' : ''}`} title={title}>
          <Avatar name={name} accountKey={accountKey} size={32} status={status} />
          {flag}
        </span>
        <span className="me-text">
          <strong>{name}</strong>
          {custom ? <CustomStatusLine custom={custom} className="me-custom" /> : <span>{sub}</span>}
        </span>
      </button>
      {anchor && <StatusMenu anchor={anchor} onClose={() => setAnchor(null)} onCustom={() => { setAnchor(null); setEditing(true) }} />}
      {editing && <CustomStatusDialog onClose={() => setEditing(false)} />}
    </>
  )
}

const CHOICES: ChosenStatus[] = ['online', 'idle', 'dnd', 'invisible']

function StatusMenu({ anchor, onClose, onCustom }: { anchor: HTMLElement; onClose: () => void; onCustom: () => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const { style, sheet } = usePopoverPosition(anchor, ref)
  const mine = usePresence((s) => s.mine)
  const custom = activeCustom(mine.custom)
  useEscapeLayer(onClose)
  useFocusTrap(ref)

  const pick = (status: ChosenStatus) => {
    setStatus(status)
    onClose()
  }

  return createPortal(
    <div className={sheet ? 'sheet-backdrop' : 'status-menu-backdrop'} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={sheet ? 'action-sheet status-menu' : 'status-menu floating'} style={style} role="menu" aria-label={t('presence.yourStatus')} tabIndex={-1}>
        {sheet && <span className="sheet-grabber" aria-hidden />}
        <div className="status-custom-row">
          <button className="status-custom-edit" role="menuitem" onClick={onCustom}>
            {custom ? <CustomStatusLine custom={custom} /> : <><Smile size={16} /> <span>{t('presence.setCustom')}</span></>}
          </button>
          {custom && (
            <button className="icon-button small" onClick={() => setCustomStatus(null)} aria-label={t('presence.clearCustom')} title={t('presence.clearCustom')}>
              <Close size={14} />
            </button>
          )}
        </div>
        {custom?.expiresAt && <div className="status-clears muted">{clearsIn(custom.expiresAt)}</div>}
        <div className="status-choices">
          {CHOICES.map((status) => (
            <button key={status} role="menuitemradio" aria-checked={mine.status === status} className={mine.status === status ? 'chosen' : ''} onClick={() => pick(status)}>
              <span className={`status-dot presence-${status}`} aria-hidden />
              <span className="status-choice-text">
                <strong>{STATUS_LABELS[status]}</strong>
                {STATUS_HINTS[status] && <span>{STATUS_HINTS[status]}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function CustomStatusDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const current = activeCustom(usePresence.getState().mine.custom)
  const [emoji, setEmoji] = useState(current?.emoji ?? '')
  const [text, setText] = useState(current?.text ?? '')
  const [clearAfter, setClearAfter] = useState<ClearAfter>(current ? (current.expiresAt === null ? 'never' : 'today') : '4h')
  const [picker, setPicker] = useState<HTMLElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  function save() {
    try {
      setCustomStatus(cleanCustom(emoji, text, expiryFor(clearAfter)))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Modal
      title={t('presence.custom.title')}
      onClose={onClose}
      footer={
        <>
          {current && <button className="button" onClick={() => { setCustomStatus(null); onClose() }}>{t('presence.custom.clear')}</button>}
          <button className="button primary" onClick={save}>{t('common.save')}</button>
        </>
      }
    >
      <p className="muted">{t('presence.custom.hint')}</p>
      <div className="field">
        <span id="custom-status-label">{t('presence.custom.label')}</span>
        <div className="custom-status-input">
          <button className="icon-button custom-status-emoji-button" onClick={(e) => setPicker(picker ? null : e.currentTarget)} aria-label={emoji ? t('presence.custom.changeEmoji', { emoji }) : t('presence.custom.pickEmoji')} title={t('presence.custom.pickEmoji')}>
            {emoji ? <span className="custom-status-emoji">{emoji}</span> : <Smile />}
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_STATUS_TEXT}
            placeholder={t('presence.custom.placeholder')}
            aria-labelledby="custom-status-label"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          {(text || emoji) && (
            <button className="icon-button small" onClick={() => { setText(''); setEmoji('') }} aria-label={t('presence.custom.clearInput')}><Close size={14} /></button>
          )}
        </div>
        <small className="field-hint muted">{text.length}/{MAX_STATUS_TEXT}</small>
      </div>
      <label className="field">
        <span>{t('presence.custom.clearAfter')}</span>
        <select value={clearAfter} onChange={(e) => setClearAfter(e.target.value as ClearAfter)}>
          {CLEAR_AFTER.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      {error && <p className="error-text">{error}</p>}
      {picker && (
        <EmojiPicker
          serverKey=""
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(value) => {
            if (!value.startsWith('<')) setEmoji(value) // server emoji don't travel between servers
            setPicker(null)
          }}
        />
      )}
    </Modal>
  )
}

/** An account's avatar with its status across your servers (DM list, friends). */
export function AccountAvatar({ accountKey, name, size }: { accountKey: string; name: string; size: number }) {
  const { status } = useAccountPresence(accountKey)
  return <Avatar name={name} accountKey={accountKey} size={size} status={status} />
}

/** The custom status of an account, or (with `fallback`) its status in words. */
export function AccountStatusText({ accountKey, fallback, className }: { accountKey: string; fallback?: boolean; className?: string }) {
  useTranslation()
  const { status, custom } = useAccountPresence(accountKey)
  if (custom) return <CustomStatusLine custom={custom} className={className} />
  return fallback ? <span className={className}>{STATUS_LABELS[status]}</span> : null
}
