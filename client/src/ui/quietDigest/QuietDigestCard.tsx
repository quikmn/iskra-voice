// "While it was quiet": the card that sums up what came in during quiet hours, once they end (state/quietDigest.ts).
// Counts and who for DMs and groups, never their content; each row opens its place. Escape or Dismiss closes it here
// and on your other devices; opening a row keeps it, so you can go through them.
import { useId, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ParseKeys } from 'i18next'
import { useApp } from '../../state/store'
import { conversationLabel } from '../../state/threads'
import { nameOf, openConversation } from '../../state/dms'
import { openGroup, titleOf, useGroups } from '../../state/groups'
import { jumpToMessage } from '../../state/jump'
import { showEvents } from '../../state/events'
import { openReminder } from '../../state/reminders'
import { dismissQuietDigest, useDigest, useQuietDigest } from '../../state/quietDigest'
import type { DigestItem, DigestSection } from '../../state/quietDigestLogic'
import { formatList, formatNumber } from '../../i18n/format'
import { messageTime } from '../format'
import { Avatar } from '../bits'
import { Close } from '../icons'
import './quiet-digest.css'

export function QuietDigestCard() {
  const { t } = useTranslation()
  const digest = useDigest()
  const stretch = useQuietDigest((s) => s.window)
  const titleId = useId()
  if (!digest || digest.total === 0 || !stretch) return null
  // Not a dialog (it doesn't take focus or Escape from the rest of the app): Escape inside it dismisses it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    e.stopPropagation()
    dismissQuietDigest()
  }
  return (
    <section className="quiet-digest" role="region" aria-labelledby={titleId} data-testid="quiet-digest" onKeyDown={onKeyDown}>
      <div className="quiet-digest-head">
        <span className="quiet-digest-mark" aria-hidden>☾</span>
        <div className="quiet-digest-titles">
          <h2 id={titleId}>{t('alerts.digest.title')}</h2>
          <span className="quiet-digest-span">{t('alerts.digest.span', { from: messageTime(stretch.start), to: messageTime(stretch.end) })}</span>
        </div>
        <button className="icon-button" onClick={dismissQuietDigest} aria-label={t('alerts.digest.dismiss')} title={t('alerts.digest.dismiss')}>
          <Close size={16} />
        </button>
      </div>
      <div className="quiet-digest-body">
        {digest.sections.map((section) => <Section key={section.kind} section={section} />)}
        {digest.offline.length > 0 && (
          <p className="muted quiet-digest-offline">{t('alerts.digest.offline', { servers: formatList(digest.offline.map((s) => s.name)) })}</p>
        )}
      </div>
      <div className="quiet-digest-actions">
        <button className="button primary" onClick={dismissQuietDigest}>{t('alerts.digest.gotIt')}</button>
      </div>
    </section>
  )
}

function Section({ section }: { section: DigestSection }) {
  const { t } = useTranslation()
  const headingId = useId()
  // Messages count per conversation; everything else one per row.
  const shown = section.items.reduce((n, i) => n + (i.type === 'dm' || i.type === 'group' ? i.count : 1), 0)
  const more = section.count - shown
  return (
    <section className="quiet-digest-section" aria-labelledby={headingId} data-kind={section.kind}>
      <h3 id={headingId}>
        <span>{t(`alerts.digest.kind.${section.kind}` as ParseKeys)}</span>
        <span className="quiet-digest-count" data-testid={`quiet-digest-count-${section.kind}`}>{formatNumber(section.count)}</span>
      </h3>
      <ul>
        {section.items.map((item) => <Row key={item.key} item={item} />)}
      </ul>
      {more > 0 && <p className="muted quiet-digest-more">{t('alerts.digest.more', { count: more })}</p>}
    </section>
  )
}

function Row({ item }: { item: DigestItem }) {
  const { t } = useTranslation()
  const servers = useApp((s) => s.servers)
  const groups = useGroups((s) => s.groups)
  let icon: ReactNode = null
  let title = ''
  let sub = ''
  let open: () => unknown = () => undefined
  switch (item.type) {
    case 'ping': {
      const server = servers[item.server]
      const name = server?.members[item.author]?.name ?? t('common.someone')
      icon = <Avatar name={name} accountKey={item.author} size={28} />
      title = t(`alerts.digest.ping.${item.kind}` as ParseKeys, { name })
      sub = server ? `${conversationLabel(server, item.channelId)} · ${server.name}` : ''
      open = () => jumpToMessage(item.server, item.channelId, item.messageId)
      break
    }
    case 'dm':
      icon = <Avatar name={nameOf(item.peer)} accountKey={item.peer} size={28} />
      title = nameOf(item.peer)
      sub = t('alerts.digest.messages', { count: item.count })
      open = () => openConversation(item.peer)
      break
    case 'group': {
      const g = groups[item.group]
      icon = <span className="quiet-digest-glyph" aria-hidden>#</span>
      title = g ? titleOf(g) : t('groups.notify.aGroup')
      sub = t('alerts.digest.messages', { count: item.count })
      open = () => openGroup(item.group)
      break
    }
    case 'event':
      icon = <span className="quiet-digest-glyph" aria-hidden>◷</span>
      title = item.title
      sub = `${t(item.started ? 'alerts.digest.started' : 'alerts.digest.soon', { time: messageTime(item.at) })}${servers[item.server] ? ` · ${servers[item.server].name}` : ''}`
      open = () => showEvents(item.server, item.eventId)
      break
    case 'reminder':
      icon = <span className="quiet-digest-glyph" aria-hidden>⏰</span>
      title = t('alerts.digest.reminder')
      sub = servers[item.server]?.name ?? ''
      open = () => openReminder(item.server, item.id)
      break
  }
  return (
    <li>
      <button className="quiet-digest-row" onClick={() => void open()}>
        <span className="quiet-digest-icon">{icon}</span>
        <span className="quiet-digest-text">
          <span className="quiet-digest-row-title">{title}</span>
          {sub && <span className="quiet-digest-row-sub">{sub}</span>}
        </span>
        {item.type !== 'event' && <time className="quiet-digest-time">{messageTime(item.at)}</time>}
      </button>
    </li>
  )
}
