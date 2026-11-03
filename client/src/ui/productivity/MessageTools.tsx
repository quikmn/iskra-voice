// "Save message" and "Remind me about this" in every message menu (channels, threads, forums, DMs, groups), and the
// small action bar and press-and-hold sheet that DM and group messages get.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { t as translate } from '../../i18n'
import { errorMessage } from '../../i18n/errors'
import { SavedFullError, toggleSaved, useIsSaved } from '../../state/saved'
import { channelTarget } from '../../state/messageRefs'
import { MAX_SAVED } from '../../state/productivityLogic'
import { Check, Copy } from '../icons'
import { useLongPress } from '../chat/useLongPress'
import { AlarmClock, Bookmark } from './icons'
import { openRemindDialog, useMessageDialogs, type MessageTarget } from './RemindDialog'
import { TranslateButton, TranslateMenuItem } from '../translate/Translate'
import type { TranslateItem } from '../../state/translate'
import './productivity.css'
import { Menu, MenuGroup, MenuItem, ToastPill } from '../kit'

type Wrap = (doneLabel: string | null, action: () => void | Promise<unknown>) => () => void

async function toggle(target: MessageTarget): Promise<void> {
  try {
    await toggleSaved(target.ref, target.snap)
  } catch (e) {
    throw e instanceof SavedFullError ? new Error(translate('productivity.saved.full', { max: MAX_SAVED })) : e
  }
}

/** The two menu items for a message; `wrap` is the menu's own click wrapper (it closes the menu, maybe with a label). */
export function SaveRemindItems({ target, wrap }: { target: MessageTarget; wrap: Wrap }) {
  const { t } = useTranslation()
  const saved = useIsSaved(target.ref)
  return (
    <>
      <MenuItem icon={<Bookmark filled={saved} />} onClick={wrap(t(saved ? 'productivity.actions.removed' : 'productivity.actions.saved'), () => toggle(target))}>
        {t(saved ? 'productivity.actions.unsave' : 'productivity.actions.save')}
      </MenuItem>
      <MenuItem icon={<AlarmClock />} onClick={wrap(null, () => openRemindDialog(target))}>{t('productivity.actions.remind')}</MenuItem>
    </>
  )
}

/** For channel, thread and forum messages. */
export function ChannelSaveRemind({ server, message, wrap }: { server: ServerState; message: Message; wrap: Wrap }) {
  // Disappearing messages can't be saved or reminded of: that would keep a copy of them.
  if (typeof message.expiresAt === 'number') return null
  return <SaveRemindItems target={channelTarget(server, message)} wrap={wrap} />
}

/** A short-lived confirmation ("Reminder set for …"). */
export function DoneToast() {
  const done = useMessageDialogs((s) => s.done)
  if (!done) return null
  return <ToastPill tone="success" icon={<Check size={16} />} className="productivity-done">{done}</ToastPill>
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
  const [error, setError] = useState<string | null>(null)
  const wrap: Wrap = (label, action) => async () => {
    try {
      await action()
      onClose()
      if (label) flashDone(label)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <Menu anchor={null} label={t('chat.actions.label')} onClose={onClose}>
      <div className="org-list" role="menu" aria-label={t('chat.actions.label')}>
        <MenuGroup>
          {text && <MenuItem icon={<Copy />} onClick={wrap(t('chat.actions.textCopied'), () => navigator.clipboard.writeText(text))}>{t('productivity.actions.copyText')}</MenuItem>}
          <SaveRemindItems target={target} wrap={wrap} />
        </MenuGroup>
        {translate && <MenuGroup><TranslateMenuItem item={translate} wrap={wrap} /></MenuGroup>}
      </div>
      {error && <p className="error-text sheet-error" role="alert">{error}</p>}
    </Menu>
  )
}

/** A short "Link copied" / "Saved" note after a menu closes. */
export function flashDone(label: string) {
  useMessageDialogs.setState({ done: label })
  setTimeout(() => useMessageDialogs.getState().done === label && useMessageDialogs.setState({ done: null }), 1800)
}
