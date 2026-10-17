// "Save message" and "Remind me about this" in every message menu (channels, threads, forums, DMs, groups), and the
// small action bar and press-and-hold sheet that DM and group messages get.
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Message } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { t as translate } from '../../i18n'
import { errorMessage } from '../../i18n/errors'
import { SavedFullError, toggleSaved, useIsSaved } from '../../state/saved'
import { channelTarget } from '../../state/messageRefs'
import { MAX_SAVED } from '../../state/productivityLogic'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { Copy } from '../icons'
import { useLongPress } from '../chat/useLongPress'
import { AlarmClock, Bookmark } from './icons'
import { openRemindDialog, useMessageDialogs, type MessageTarget } from './RemindDialog'
import { TranslateButton, TranslateMenuItem } from '../translate/Translate'
import type { TranslateItem } from '../../state/translate'
import './productivity.css'

type Wrap = (doneLabel: string | null, action: () => void | Promise<unknown>) => () => void

async function toggle(target: MessageTarget): Promise<void> {
  try {
    await toggleSaved(target.ref, target.snap)
  } catch (e) {
    throw e instanceof SavedFullError ? new Error(translate('productivity.saved.full', { max: MAX_SAVED })) : e
  }
}

/** The two menu items for a message; `wrap` is the menu's own click wrapper (it closes the menu, maybe with a label). */
export function SaveRemindItems({ target, wrap, icons }: { target: MessageTarget; wrap: Wrap; icons?: boolean }) {
  const { t } = useTranslation()
  const saved = useIsSaved(target.ref)
  return (
    <>
      <button role="menuitem" onClick={wrap(t(saved ? 'productivity.actions.removed' : 'productivity.actions.saved'), () => toggle(target))}>
        {icons && <Bookmark filled={saved} />}{t(saved ? 'productivity.actions.unsave' : 'productivity.actions.save')}
      </button>
      <button role="menuitem" onClick={wrap(null, () => openRemindDialog(target))}>
        {icons && <AlarmClock />}{t('productivity.actions.remind')}
      </button>
    </>
  )
}

/** For channel, thread and forum messages. */
export function ChannelSaveRemind({ server, message, wrap, icons }: { server: ServerState; message: Message; wrap: Wrap; icons?: boolean }) {
  // Disappearing messages can't be saved or reminded of: that would keep a copy of them.
  if (typeof message.expiresAt === 'number') return null
  return <SaveRemindItems target={channelTarget(server, message)} wrap={wrap} icons={icons} />
}

/** A short-lived confirmation ("Reminder set for …"). */
export function DoneToast() {
  const done = useMessageDialogs((s) => s.done)
  if (!done) return null
  return <div className="productivity-done" role="status">{done}</div>
}

// ── DM and group messages ───────────────────────────────────────────────────

/**
 * Hover actions (desktop) and press-and-hold (phones) for a DM or group message row. Spread `rowProps` on the row and
 * render `tools` inside it.
 */
export function usePrivateMessageTools(target: MessageTarget | null, text: string, translate: TranslateItem | null = null) {
  const [sheet, setSheet] = useState(false)
  const longPress = useLongPress(() => setSheet(true), !!target)
  if (!target) return { rowProps: { className: '' }, tools: null }
  return {
    rowProps: { ...longPress, className: sheet ? 'pressed' : '' },
    tools: (
      <>
        <PrivateActions target={target} text={text} translate={translate} />
        {sheet && <PrivateSheet target={target} text={text} translate={translate} onClose={() => setSheet(false)} />}
      </>
    ),
  }
}

function PrivateActions({ target, text, translate }: { target: MessageTarget; text: string; translate: TranslateItem | null }) {
  const { t } = useTranslation()
  const saved = useIsSaved(target.ref)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="message-actions private-actions">
      <button onClick={() => void toggle(target).catch((e) => setError(errorMessage(e)))} title={t(saved ? 'productivity.actions.unsave' : 'productivity.actions.save')}
        aria-label={t(saved ? 'productivity.actions.unsave' : 'productivity.actions.save')} aria-pressed={saved}>
        <Bookmark size={15} filled={saved} />
      </button>
      <button onClick={() => openRemindDialog(target)} title={t('productivity.actions.remind')} aria-label={t('productivity.actions.remind')}>
        <AlarmClock size={15} />
      </button>
      {text && (
        <button onClick={() => void navigator.clipboard.writeText(text)} title={t('productivity.actions.copyText')} aria-label={t('productivity.actions.copyText')}>
          <Copy size={15} />
        </button>
      )}
      {translate && <TranslateButton item={translate} />}
      {error && <span className="error-text" role="alert">{error}</span>}
    </div>
  )
}

function PrivateSheet({ target, text, translate, onClose }: { target: MessageTarget; text: string; translate: TranslateItem | null; onClose: () => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEscapeLayer(onClose)
  useFocusTrap(ref)
  const wrap: Wrap = (_label, action) => async () => {
    try {
      await action()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="action-sheet" role="dialog" aria-label={t('chat.actions.label')} ref={ref} tabIndex={-1}>
        <span className="sheet-grabber" aria-hidden />
        <div className="sheet-list" role="menu">
          <SaveRemindItems target={target} wrap={wrap} icons />
          {text && <button role="menuitem" onClick={wrap(null, () => navigator.clipboard.writeText(text))}><Copy />{t('productivity.actions.copyText')}</button>}
          <TranslateMenuItem item={translate} wrap={wrap} icon />
        </div>
        {error && <p className="error-text sheet-error" role="alert">{error}</p>}
      </div>
    </div>,
    document.body,
  )
}
