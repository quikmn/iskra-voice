// My settings → Notifications: alert words, follows and quiet hours. Also the quiet hours line in the status menu.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t as translate } from '../../i18n'
import { setFollowing, updateAlerts, useAlerts, useQuietNow } from '../../state/alerts'
import { MAX_FOLLOWS, MAX_WORDS, addWord, cleanWord, clockText, localTimeZone, parseClock, type Follow } from '../../state/alertsLogic'
import { currentPushSupport, usePush } from '../../state/push'
import { useServerRoles } from '../../state/roles'
import { useApp, type ServerState } from '../../state/store'
import { Close } from '../icons'
import { openMySettings } from '../settings/open'
import './alerts.css'

/** "Alice in #general" / "@Raiders anywhere", for a follow on `server` (which may be gone). */
export function followWords(follow: Follow, server: ServerState | undefined, roles: { id: number; name: string }[]): { who: string; where: string } {
  const who = follow.member !== undefined
    ? server?.members[follow.member]?.name ?? translate('alerts.follow.someone')
    : translate('alerts.follow.role', { role: roles.find((r) => r.id === follow.role)?.name ?? translate('alerts.follow.aRole') })
  const channel = follow.channel === undefined ? undefined : server?.channels.find((c) => c.id === follow.channel)
  const where = follow.channel === undefined ? translate('alerts.follow.anywhere') : channel ? translate('alerts.follow.in', { channel: channel.name }) : translate('alerts.follow.aChannel')
  return { who, where }
}

export function FollowSettings() {
  const { t } = useTranslation()
  const follows = useAlerts((s) => s.settings.follows)
  const servers = useApp((s) => s.servers)
  const order = useApp((s) => s.order).filter((k) => servers[k]?.me)
  const [serverKey, setServerKey] = useState(order[0] ?? '')
  const server = servers[serverKey] ?? servers[order[0]]
  const roles = useServerRoles(server?.key ?? '')
  const [who, setWho] = useState('')
  const [where, setWhere] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const people = server ? Object.values(server.members).filter((m) => m.accountKey !== server.me?.accountKey && !m.bot).sort((a, b) => a.name.localeCompare(b.name)) : []

  function add() {
    if (!server || !who) return
    const follow: Follow = { server: server.key }
    if (who.startsWith('role:')) follow.role = Number(who.slice(5))
    else follow.member = who
    if (where) follow.channel = Number(where)
    if (follows.filter((f) => f.server === server.key).length >= MAX_FOLLOWS) return setProblem(t('alerts.follow.full', { max: MAX_FOLLOWS }))
    if (!setFollowing(follow, true)) return setProblem(t('alerts.follow.duplicate'))
    setWho('')
    setProblem(null)
  }

  return (
    <div className="alert-settings" role="group" aria-labelledby="alert-follow-title">
      <h3 className="h4" id="alert-follow-title">{t('alerts.follow.title')}</h3>
      <p className="muted">{t('alerts.follow.intro')}</p>
      {server && (
        <form className="alert-add" onSubmit={(e) => { e.preventDefault(); add() }}>
          {order.length > 1 && (
            <select value={server.key} aria-label={t('alerts.follow.server')} onChange={(e) => { setServerKey(e.target.value); setWho(''); setWhere('') }}>
              {order.map((k) => <option key={k} value={k}>{servers[k].name}</option>)}
            </select>
          )}
          <select value={who} aria-label={t('alerts.follow.who')} onChange={(e) => { setWho(e.target.value); setProblem(null) }}>
            <option value="">{t('alerts.follow.who')}…</option>
            <optgroup label={t('alerts.follow.people')}>
              {people.map((m) => <option key={m.accountKey} value={m.accountKey}>{m.name}</option>)}
            </optgroup>
            {roles.length > 0 && (
              <optgroup label={t('alerts.follow.roles')}>
                {roles.map((r) => <option key={r.id} value={`role:${r.id}`}>@{r.name}</option>)}
              </optgroup>
            )}
          </select>
          <select value={where} aria-label={t('alerts.follow.where')} onChange={(e) => setWhere(e.target.value)}>
            <option value="">{t('alerts.follow.anyChannel')}</option>
            {server.channels.filter((c) => c.kind !== 'voice' && c.kind !== 'stage').map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
          <button className="button" type="submit" disabled={!who}>{t('alerts.follow.add')}</button>
        </form>
      )}
      {problem && <p className="error-text" role="alert">{problem}</p>}
      {follows.length === 0 ? (
        <p className="muted alert-empty">{t('alerts.follow.empty')}</p>
      ) : (
        <ul className="alert-chips" aria-label={t('alerts.follow.title')}>
          {follows.map((f) => <FollowChip key={`${f.server}:${f.member ?? ''}:${f.role ?? ''}:${f.channel ?? ''}`} follow={f} />)}
        </ul>
      )}
      <p className="muted alert-count">{t('alerts.follow.count', { count: follows.length })}</p>
    </div>
  )
}

function FollowChip({ follow }: { follow: Follow }) {
  const { t } = useTranslation()
  const server = useApp((s) => s.servers[follow.server])
  const roles = useServerRoles(follow.server)
  const { who, where } = followWords(follow, server, roles)
  return (
    <li className="alert-chip">
      <span className="alert-chip-text">{who} {where}</span>
      <span className="alert-chip-where">{server?.name ?? t('alerts.follow.gone')}</span>
      <button className="icon-button small" aria-label={t('alerts.follow.remove', { who })} title={t('alerts.follow.remove', { who })}
        onClick={() => setFollowing(follow, false)}>
        <Close size={12} />
      </button>
    </li>
  )
}

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
