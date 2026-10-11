// The bell in the server rail (with what's new for you), the "Saved messages" row at Home, and the layer that shows
// the inbox, reminder dialogs and toasts wherever they're opened from.
import { useTranslation } from 'react-i18next'
import { openInbox, useInbox, useInboxBadge } from '../../state/inbox'
import { useSavedList } from '../../state/saved'
import { InboxPanel, ReminderToasts } from './InboxPanel'
import { RemindDialog, useMessageDialogs } from './RemindDialog'
import { DoneToast } from './MessageTools'
import { Bell, Bookmark } from './icons'
import './productivity.css'

export function InboxButton({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const badge = useInboxBadge()
  return (
    <button
      className="server-icon inbox-icon"
      title={t('productivity.inbox.title')}
      aria-label={badge > 0 ? t('productivity.inbox.buttonCount', { count: badge }) : t('productivity.inbox.button')}
      onClick={() => {
        openInbox('inbox')
        onNavigate?.()
      }}
    >
      <Bell size={22} />
      {badge > 0 && <span className="badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  )
}

export function SavedRow({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation()
  const count = useSavedList().length
  return (
    <button className="channel" onClick={() => {
      openInbox('saved')
      onNavigate()
    }}>
      <span className="hash"><Bookmark size={16} /></span>
      <span className="channel-name">{t('productivity.saved.title')}</span>
      {count > 0 && <span className="muted saved-count">{count}</span>}
    </button>
  )
}

/** Mounted once in the shell. */
export function ProductivityLayer() {
  const open = useInbox((s) => s.open)
  const remind = useMessageDialogs((s) => s.remind)
  return (
    <>
      {open && <InboxPanel tab={open} />}
      {remind && <RemindDialog target={remind} onClose={() => useMessageDialogs.setState({ remind: null })} />}
      <ReminderToasts />
      <DoneToast />
    </>
  )
}
