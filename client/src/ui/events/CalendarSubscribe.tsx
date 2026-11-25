// "Add to my calendar": the private link a calendar app (Google, Outlook, Apple) subscribes to, and in the phone app
// the switch that writes this server's events straight into the phone's own calendar.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { formatDate } from '../../i18n/format'
import type { ServerState } from '../../state/store'
import { createFeed, loadFeed, removeFeed, useCalendar } from '../../state/calendar'
import { feedBase, feedLinks } from '../../state/calendarLogic'
import { choosePhoneCalendar, phoneCalendarAvailable, phoneCalendars, stopPhoneCalendar, usePhoneCalendarChoice } from '../../state/phoneCalendar'
import type { PhoneCalendar } from '../../state/phoneCalendarLogic'
import { Modal, Spinner } from '../bits'
import { Check, Copy, Globe } from '../icons'
import { CalendarPlus } from '../forums/icons'
import { Switch } from '../kit'

export function CalendarSubscribe({ server, onBack, onClose }: { server: ServerState; onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Modal title={t('calendar.subscribe.title')} onBack={onBack} onClose={onClose} wide className="events-modal">
      <div className="cal-subscribe" data-testid="calendar-subscribe">
        {phoneCalendarAvailable() && <PhoneSection server={server} />}
        <FeedSection server={server} />
        {!phoneCalendarAvailable() && <p className="muted cal-note">{t('calendar.phone.onPhones')}</p>}
      </div>
    </Modal>
  )
}

function FeedSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const feed = useCalendar((s) => s.feeds[server.key])
  const path = useCalendar((s) => s.paths[server.key])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'new' | 'off' | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    loadFeed(server.key).catch((e) => setError(errorMessage(e)))
  }, [server.key])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      setConfirm(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const heading = <h3><Globe size={16} /> {t('calendar.subscribe.heading')}</h3>
  if (feed === undefined) return <section className="cal-section">{heading}{error ? <p className="error-text" role="alert">{error}</p> : <Spinner />}</section>
  if (feed === null) return <section className="cal-section">{heading}<p className="muted">{t('calendar.subscribe.tooOld')}</p></section>
  if (!feed.allowed) return <section className="cal-section">{heading}<p className="muted" data-testid="calendar-feeds-off">{t('calendar.subscribe.disallowed')}</p></section>

  const base = feedBase(feed.address, server)
  if (base === null) {
    return (
      <section className="cal-section" data-testid="calendar-not-reachable">
        {heading}
        <div className="cal-callout" role="note">
          <strong>{t('calendar.subscribe.notReachableTitle')}</strong>
          <p>{t('calendar.subscribe.notReachable')}</p>
          <p>{server.me?.role === 'owner' ? t('calendar.subscribe.notReachableOwner') : t('calendar.subscribe.notReachableElse')}</p>
        </div>
      </section>
    )
  }

  const links = path ? feedLinks(base, path, server.name) : null
  return (
    <section className="cal-section">
      {heading}
      <p>{t('calendar.subscribe.intro')}</p>
      <p className="muted">{t('calendar.subscribe.shared')}</p>

      {!feed.on && (
        <button className="button primary" disabled={busy} onClick={() => void run(() => createFeed(server.key))}>
          <CalendarPlus size={16} /> {t('calendar.subscribe.turnOn')}
        </button>
      )}

      {feed.on && links && (
        <>
          <label className="field cal-link">
            <span>{t('calendar.subscribe.link')}</span>
            <div className="cal-link-row">
              <input readOnly value={links.https} data-testid="calendar-link" onFocus={(e) => e.target.select()} />
              <button
                className="button" onClick={() => void navigator.clipboard.writeText(links.https).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }).catch(() => undefined)}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? t('calendar.subscribe.copied') : t('calendar.subscribe.copy')}
              </button>
            </div>
          </label>
          <div className="cal-open">
            <a className="button" href={links.webcal} data-testid="calendar-webcal">{t('calendar.subscribe.open')}</a>
            <a className="button" href={links.google} target="_blank" rel="noreferrer noopener">{t('calendar.subscribe.google')}</a>
            <a className="button" href={links.outlook} target="_blank" rel="noreferrer noopener">{t('calendar.subscribe.outlook')}</a>
          </div>
          <details className="cal-steps">
            <summary>{t('calendar.subscribe.howTo')}</summary>
            <ul>
              <li>{t('calendar.subscribe.stepsGoogle')}</li>
              <li>{t('calendar.subscribe.stepsOutlook')}</li>
              <li>{t('calendar.subscribe.stepsApple')}</li>
            </ul>
          </details>
        </>
      )}

      {feed.on && !links && <p className="cal-callout" role="note" data-testid="calendar-link-hidden">{t('calendar.subscribe.hidden')}</p>}

      {feed.on && (
        <>
          <p className="muted cal-note">{t('calendar.subscribe.delay')}</p>
          <p className="muted cal-note" data-testid="calendar-feed-state">
            {feed.createdAt !== null && t('calendar.subscribe.made', { date: formatDate(feed.createdAt, { dateStyle: 'medium' }) })}
            {' · '}
            {feed.fetchedAt !== null ? t('calendar.subscribe.fetched', { when: formatDate(feed.fetchedAt, { dateStyle: 'medium', timeStyle: 'short' }) }) : t('calendar.subscribe.neverFetched')}
          </p>
          {confirm ? (
            <div className="confirm-inline cal-confirm" role="alertdialog" aria-label={confirm === 'new' ? t('calendar.subscribe.newLink') : t('calendar.subscribe.turnOff')}>
              <span>{confirm === 'new' ? t('calendar.subscribe.newLinkConfirm') : t('calendar.subscribe.turnOffConfirm')}</span>
              <button className="button danger small" disabled={busy} onClick={() => void run(() => (confirm === 'new' ? createFeed(server.key) : removeFeed(server.key)))}>
                {confirm === 'new' ? t('calendar.subscribe.newLink') : t('calendar.subscribe.turnOff')}
              </button>
              <button className="button small" onClick={() => setConfirm(null)}>{t('calendar.subscribe.keep')}</button>
            </div>
          ) : (
            <div className="cal-open">
              <button className="button small" onClick={() => setConfirm('new')}>{t('calendar.subscribe.newLink')}</button>
              <button className="button small danger-text" onClick={() => setConfirm('off')}>{t('calendar.subscribe.turnOff')}</button>
            </div>
          )}
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
  )
}

function PhoneSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const choice = usePhoneCalendarChoice(server)
  const [calendars, setCalendars] = useState<PhoneCalendar[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setProblem(null)
    try {
      await action()
    } catch {
      setProblem(t('calendar.phone.failed'))
    } finally {
      setBusy(false)
    }
  }

  const pick = () => run(async () => {
    const list = await phoneCalendars()
    if (list === null) return setProblem(t('calendar.phone.denied'))
    if (list.length === 0) return setProblem(t('calendar.phone.none'))
    setCalendars(list)
  })

  return (
    <section className="cal-section" data-testid="calendar-phone">
      <h3><CalendarPlus size={16} /> {t('calendar.phone.heading')}</h3>
      <div className="cal-switch-row">
        <div>
          <strong>{t('calendar.phone.title')}</strong>
          <p className="muted">{t('calendar.phone.help')}</p>
        </div>
        <Switch
          checked={!!choice || calendars !== null} disabled={busy} label={t('calendar.phone.title')} testId="calendar-phone-switch"
          onChange={() => {
            if (calendars !== null && !choice) setCalendars(null)
            else if (choice) void run(() => stopPhoneCalendar(server))
            else void pick()
          }}
        />
      </div>
      {calendars !== null && (
        <div className="cal-pick" role="radiogroup" aria-label={t('calendar.phone.pick')}>
          <span className="k-field-label">{t('calendar.phone.pick')}</span>
          {calendars.map((calendar) => (
            <button
              key={calendar.id} role="radio" aria-checked={choice?.calendarId === calendar.id} disabled={busy}
              className={`cal-pick-row ${choice?.calendarId === calendar.id ? 'on' : ''}`}
              onClick={() => void run(async () => {
                await choosePhoneCalendar(server, calendar)
                setCalendars(null)
              })}
            >
              <strong>{calendar.name}</strong>
              {calendar.account && calendar.account !== calendar.name && <span className="muted">{calendar.account}</span>}
            </button>
          ))}
        </div>
      )}
      {choice && calendars === null && (
        <p className="cal-note">
          {t('calendar.phone.into', { calendar: choice.calendarName })}{' '}
          <button className="link" disabled={busy} onClick={() => void pick()}>{t('calendar.phone.change')}</button>
          <span className="muted"> · {t('calendar.phone.offNote')}</span>
        </p>
      )}
      {problem && <p className="error-text" role="alert">{problem}</p>}
    </section>
  )
}
