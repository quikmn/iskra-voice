// My settings → Notifications: alert words and quiet hours. Also the quiet hours line in the status menu.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { updateAlerts, useAlerts, useQuietNow } from '../../state/alerts'
import { MAX_WORDS, addWord, cleanWord, clockText, localTimeZone, parseClock } from '../../state/alertsLogic'
import { currentPushSupport, usePush } from '../../state/push'
import { useApp } from '../../state/store'
import { Close } from '../icons'
import { openMySettings } from '../settings/open'
import './alerts.css'

export function AlertWordsSettings() {
  const { t } = useTranslation()
  const settings = useAlerts((s) => s.settings)
  const servers = useApp((s) => s.servers)
  const order = useApp((s) => s.order)
  const [text, setText] = useState('')
  const [where, setWhere] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const full = settings.words.length >= MAX_WORDS
  const pushable = currentPushSupport() === 'supported'

  function add() {
    if (!text.trim()) return
    if (full) return setProblem(t('alerts.words.full', { max: MAX_WORDS }))
    if (!cleanWord(text)) return setProblem(t('alerts.words.invalid'))
    const words = addWord(settings.words, text, where || undefined)
    if (!words) return setProblem(t('alerts.words.duplicate'))
    updateAlerts({ words })
    setText('')
    setProblem(null)
  }

  return (
    <div className="alert-settings" role="group" aria-labelledby="alert-words-title">
      <h3 className="h4" id="alert-words-title">{t('alerts.words.title')}</h3>
      <p className="muted">{t('alerts.words.intro')}</p>
      <form className="alert-add" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input value={text} maxLength={50} placeholder={t('alerts.words.placeholder')} aria-label={t('alerts.words.label')} disabled={full}
          onChange={(e) => { setText(e.target.value); setProblem(null) }} />
        {order.length > 1 && (
          <select value={where} aria-label={t('alerts.words.where')} onChange={(e) => setWhere(e.target.value)}>
            <option value="">{t('alerts.words.everywhere')}</option>
            {order.filter((k) => servers[k]).map((k) => <option key={k} value={k}>{servers[k].name}</option>)}
          </select>
        )}
        <button className="button" type="submit" disabled={full || !text.trim()}>{t('alerts.words.add')}</button>
      </form>
      {problem && <p className="error-text" role="alert">{problem}</p>}
      {settings.words.length === 0 ? (
        <p className="muted alert-empty">{t('alerts.words.empty')}</p>
      ) : (
        <ul className="alert-chips" aria-label={t('alerts.words.label')}>
          {settings.words.map((w) => (
            <li key={`${w.server ?? ''}:${w.text}`} className="alert-chip">
              <span className="alert-chip-text">{w.text}</span>
              {w.server && <span className="alert-chip-where">{servers[w.server]?.name ?? t('alerts.words.gone')}</span>}
              <button className="icon-button small" aria-label={t('alerts.words.remove', { word: w.text })} title={t('alerts.words.remove', { word: w.text })}
                onClick={() => updateAlerts({ words: settings.words.filter((x) => x !== w) })}>
                <Close size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted alert-count">{t('alerts.words.count', { count: settings.words.length, max: MAX_WORDS })}</p>
      <p className="muted alert-privacy">{t('alerts.words.local')}</p>
      {pushable && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={settings.closed} onChange={(e) => updateAlerts({ closed: e.target.checked })} />
            {t('alerts.words.closed')}
          </label>
          <p className="muted alert-privacy">{t('alerts.words.closedHint')}</p>
        </>
      )}
    </div>
  )
}

/** Monday first: [day index (0 = Sunday), short name in the app's language]. */
function useWeekdays(language: string): [number, string][] {
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' })
    // 2024-01-07 was a Sunday.
    return [1, 2, 3, 4, 5, 6, 0].map((day) => [day, format.format(new Date(Date.UTC(2024, 0, 7 + day)))] as [number, string])
  }, [language])
}

function zones(current: string): string[] {
  let all: string[] = []
  try {
    all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    /* an older browser: just the current one and this device's */
  }
  return [...new Set([current, localTimeZone(), 'UTC', ...all])].sort()
}

export function QuietHoursSettings() {
  const { t, i18n } = useTranslation()
  const settings = useAlerts((s) => s.settings)
  const quiet = settings.quiet
  const days = useWeekdays(i18n.language)
  const pushOn = useMemo(() => Object.values(usePush.getState().servers).some((s) => s === 'on'), [])
  const here = localTimeZone()
  const zoneList = useMemo(() => zones(quiet.timeZone), [quiet.timeZone])
  const setQuiet = (patch: Partial<typeof quiet>) => updateAlerts({ quiet: { ...quiet, ...patch } })

  return (
    <div className="alert-settings quiet-settings" role="group" aria-labelledby="quiet-title">
      <h3 className="h4" id="quiet-title">{t('alerts.quiet.title')}</h3>
      <label className="checkbox">
        <input type="checkbox" checked={settings.quietOn} onChange={(e) => updateAlerts({ quietOn: e.target.checked })} />
        {t('alerts.quiet.toggle')}
      </label>
      <p className="muted">{t('alerts.quiet.hint')}</p>
      {settings.quietOn && (
        <div className="quiet-body">
          <div className="quiet-times">
            <label className="field inline">
              <span>{t('alerts.quiet.from')}</span>
              <input type="time" value={clockText(quiet.from)} onChange={(e) => { const m = parseClock(e.target.value); if (m !== null) setQuiet({ from: m }) }} />
            </label>
            <label className="field inline">
              <span>{t('alerts.quiet.to')}</span>
              <input type="time" value={clockText(quiet.to)} onChange={(e) => { const m = parseClock(e.target.value); if (m !== null) setQuiet({ to: m }) }} />
            </label>
          </div>
          {quiet.from > quiet.to && <p className="muted quiet-note">{t('alerts.quiet.overnight')}</p>}
          {quiet.from === quiet.to && <p className="muted quiet-note">{t('alerts.quiet.allDay')}</p>}
          <fieldset className="quiet-days">
            <legend>{t('alerts.quiet.days')}</legend>
            {days.map(([day, name]) => {
              const on = (quiet.days & (1 << day)) !== 0
              const next = quiet.days ^ (1 << day)
              return (
                <button key={day} type="button" className={`quiet-day ${on ? 'on' : ''}`} aria-pressed={on}
                  title={next === 0 ? t('alerts.quiet.noDays') : undefined}
                  onClick={() => next !== 0 && setQuiet({ days: next })}>
                  {name}
                </button>
              )
            })}
          </fieldset>
          <label className="field">
            <span>{t('alerts.quiet.timeZone')}</span>
            <select value={quiet.timeZone} onChange={(e) => setQuiet({ timeZone: e.target.value })}>
              {zoneList.map((z) => <option key={z} value={z}>{z.replaceAll('_', ' ')}</option>)}
            </select>
          </label>
          {quiet.timeZone !== here && (
            <button className="button ghost quiet-here" onClick={() => setQuiet({ timeZone: here })}>{t('alerts.quiet.useHere', { zone: here.replaceAll('_', ' ') })}</button>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={quiet.mentions} onChange={(e) => setQuiet({ mentions: e.target.checked })} />
            {t('alerts.quiet.mentions')}
          </label>
          {pushOn && <p className="muted alert-privacy">{t('alerts.quiet.pushNote')}</p>}
        </div>
      )}
    </div>
  )
}

/** In the status menu while quiet hours are set: when they end (or start), and a way to their settings. */
export function QuietStatusRow({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const settings = useAlerts((s) => s.settings)
  const active = useQuietNow()
  if (!settings.quietOn) return null
  const { quiet } = settings
  const label = active
    ? (quiet.from === quiet.to ? t('alerts.status.today') : t('alerts.status.until', { time: clockText(quiet.to) }))
    : t('alerts.status.from', { time: clockText(quiet.from) })
  return (
    <button className={`status-quiet ${active ? 'active' : ''}`} role="menuitem" title={t('alerts.status.settings')}
      onClick={() => { onClose(); openMySettings('notifications') }}>
      <span className="status-quiet-moon" aria-hidden>☾</span>
      <span>{label}</span>
    </button>
  )
}
