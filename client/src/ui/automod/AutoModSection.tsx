// Settings → AutoMod (admins, or a role that manages AutoMod): rules the server applies before a message is stored.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { AutoModAction, AutoModConfig } from '../../core/protocol'
import {
  activeRules, AUTOMOD_LIMITS, parseDomains, parseList, suggestedAutoMod, wordListProblem,
} from '../../state/automod'
import { durationLabel, TIMEOUT_OPTIONS } from '../../state/moderationRules'
import { has } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import { connectionFor, type ServerState } from '../../state/store'
import { Spinner } from '../bits'
import '../dialogs/InternetSettings.css'
import './automod.css'

interface Draft {
  config: AutoModConfig
  blocked: string
  allowed: string
  domains: string
}

const toDraft = (config: AutoModConfig): Draft => ({
  config,
  blocked: config.words.blocked.join('\n'),
  allowed: config.words.allowed.join('\n'),
  domains: config.links.allowedDomains.join('\n'),
})

type RuleKey = 'words' | 'mentions' | 'flood' | 'duplicates' | 'links'

export function AutoModSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const canTimeout = has(server.me, roles, 'timeoutMembers')
  const [saved, setSaved] = useState<AutoModConfig | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    connectionFor(server.key)?.request('automod.get', {})
      .then(({ automod }) => { setSaved(automod); setDraft(toDraft(automod)) })
      .catch((e: unknown) => setError(errorMessage(e)))
  }, [server.key])

  const textChannels = server.channels.filter((c) => c.kind === 'text')
  const exemptable = server.channels

  // The form as settings, or the first problem with it.
  const built = useMemo((): { config: AutoModConfig } | { problem: string } | null => {
    if (!draft) return null
    const blocked = parseList(draft.blocked)
    const allowed = parseList(draft.allowed)
    const problem = wordListProblem(blocked, AUTOMOD_LIMITS.blocked) ?? wordListProblem(allowed, AUTOMOD_LIMITS.allowed)
    if (problem) return { problem }
    const { domains, bad } = parseDomains(draft.domains)
    if (bad) return { problem: t('automod.problems.badDomain', { domain: bad }) }
    if (domains.length > AUTOMOD_LIMITS.domains) return { problem: t('automod.problems.tooManyDomains', { max: AUTOMOD_LIMITS.domains }) }
    const c = draft.config
    return { config: { ...c, words: { ...c.words, blocked, allowed }, links: { ...c.links, allowedDomains: domains } } }
  }, [draft, t])

  if (!draft || !saved) {
    return (
      <section className="settings-section automod" data-testid="automod-section">
        <h3>{t('automod.title')}</h3>
        {error ? <p className="error-text">{error}</p> : <Spinner />}
      </section>
    )
  }

  const c = draft.config
  const dirty = !!built && 'config' in built && JSON.stringify(built.config) !== JSON.stringify(saved)
  const patch = (next: Partial<AutoModConfig>) => setDraft((d) => d && { ...d, config: { ...d.config, ...next } })
  function rule<K extends RuleKey>(key: K, next: Partial<AutoModConfig[K]>) {
    setDraft((d) => d && { ...d, config: { ...d.config, [key]: { ...d.config[key], ...next } } })
  }

  async function save() {
    if (!built || !('config' in built)) return
    setBusy(true)
    setError(null)
    try {
      const reply = await connectionFor(server.key)?.request('automod.update', { automod: built.config })
      if (reply) {
        setSaved(reply.automod)
        setDraft(toDraft(reply.automod))
        setDone(true)
        setTimeout(() => setDone(false), 1800)
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const action = (key: RuleKey) => (
    <ActionRow
      action={c[key].action}
      canTimeout={canTimeout}
      alertsPossible={c.alertChannelId !== null}
      onChange={(a) => rule(key, { action: a } as Partial<AutoModConfig[typeof key]>)}
    />
  )
  const active = activeRules(c)

  return (
    <section className="settings-section automod" data-testid="automod-section">
      <h3>{t('automod.title')}</h3>
      <p className="muted">{t('automod.intro')}</p>

      <div className="internet-head automod-master">
        <div>
          <strong>{c.enabled ? t('automod.isOn') : t('automod.isOff')}</strong>
          <p className="internet-summary">
            {c.enabled
              ? active.length ? t('automod.rulesOn', { count: active.length }) : t('automod.noRules')
              : t('automod.offSummary')}
          </p>
        </div>
        <button className={`switch ${c.enabled ? 'on' : ''}`} role="switch" aria-checked={c.enabled} aria-label={t('automod.title')}
          onClick={() => patch({ enabled: !c.enabled })}>
          <span />
        </button>
      </div>
      <div className="automod-preset">
        <button className="button small" onClick={() => setDraft((d) => d && {
          ...d, config: suggestedAutoMod(d.config, canTimeout, d.config.alertChannelId ?? null),
        })}>{t('automod.suggested')}</button>
        <span className="muted">{t('automod.suggestedHint')}</span>
      </div>
      <p className="automod-note muted">{t('automod.e2eeNote')}</p>

      <Rule title={t('automod.words.title')} hint={t('automod.words.hint')}
        on={c.words.enabled} onToggle={(on) => rule('words', { enabled: on })}>
        <label className="field">
          <span>{t('automod.words.blocked', { count: parseList(draft.blocked).length, max: AUTOMOD_LIMITS.blocked })}</span>
          <textarea rows={5} value={draft.blocked} spellCheck={false} aria-label={t('automod.words.blockedLabel')}
            onChange={(e) => setDraft({ ...draft, blocked: e.target.value })} placeholder={t('automod.words.blockedPlaceholder')} />
        </label>
        <label className="field">
          <span>{t('automod.words.allowed')}</span>
          <textarea rows={2} value={draft.allowed} spellCheck={false} aria-label={t('automod.words.allowedLabel')}
            onChange={(e) => setDraft({ ...draft, allowed: e.target.value })} placeholder={t('automod.words.allowedPlaceholder')} />
        </label>
        {action('words')}
      </Rule>

      <Rule title={t('automod.mentions.title')} hint={t('automod.mentions.hint')}
        on={c.mentions.enabled} onToggle={(on) => rule('mentions', { enabled: on })}>
        <div className="automod-inline">
          <span>{t('automod.mentions.before')}</span>
          <NumberInput label={t('automod.mentions.label')} value={c.mentions.max} min={1} max={50} onChange={(max) => rule('mentions', { max })} />
          <span>{t('automod.mentions.after')}</span>
        </div>
        {action('mentions')}
      </Rule>

      <Rule title={t('automod.flood.title')} hint={t('automod.flood.hint')}
        on={c.flood.enabled} onToggle={(on) => rule('flood', { enabled: on })}>
        <div className="automod-inline">
          <span>{t('automod.flood.before')}</span>
          <NumberInput label={t('automod.flood.count')} value={c.flood.count} min={2} max={50} onChange={(count) => rule('flood', { count })} />
          <span>{t('automod.flood.middle')}</span>
          <NumberInput label={t('automod.flood.seconds')} value={c.flood.seconds} min={2} max={120} onChange={(seconds) => rule('flood', { seconds })} />
          <span>{t('automod.flood.after')}</span>
        </div>
        {action('flood')}
      </Rule>

      <Rule title={t('automod.duplicates.title')} hint={t('automod.duplicates.hint')}
        on={c.duplicates.enabled} onToggle={(on) => rule('duplicates', { enabled: on })}>
        <div className="automod-inline">
          <span>{t('automod.duplicates.before')}</span>
          <NumberInput label={t('automod.duplicates.count')} value={c.duplicates.count} min={1} max={20} onChange={(count) => rule('duplicates', { count })} />
          <span>{t('automod.duplicates.middle')}</span>
          <NumberInput label={t('automod.duplicates.seconds')} value={c.duplicates.seconds} min={5} max={3600} onChange={(seconds) => rule('duplicates', { seconds })} />
          <span>{t('automod.duplicates.after')}</span>
        </div>
        {action('duplicates')}
      </Rule>

      <Rule title={t('automod.links.title')} hint={t('automod.links.hint')}
        on={c.links.enabled} onToggle={(on) => rule('links', { enabled: on })}>
        <div className="automod-radios" role="radiogroup" aria-label={t('automod.links.which')}>
          <label className="checkbox">
            <input type="radio" name={`links-${server.key}`} checked={c.links.mode === 'invites'} onChange={() => rule('links', { mode: 'invites' })} />
            {t('automod.links.invites')}
          </label>
          <label className="checkbox">
            <input type="radio" name={`links-${server.key}`} checked={c.links.mode === 'all'} onChange={() => rule('links', { mode: 'all' })} />
            {t('automod.links.all')}
          </label>
        </div>
        {c.links.mode === 'all' && (
          <label className="field">
            <span>{t('automod.links.allowed')}</span>
            <textarea rows={2} value={draft.domains} spellCheck={false} aria-label={t('automod.links.allowedLabel')}
              onChange={(e) => setDraft({ ...draft, domains: e.target.value })} placeholder={t('automod.links.allowedPlaceholder')} />
          </label>
        )}
        {action('links')}
      </Rule>

      <div className="automod-group">
        <h4>{t('automod.alerts.title')}</h4>
        <label className="field">
          <span>{t('automod.alerts.postIn')}</span>
          <select value={c.alertChannelId ?? ''} aria-label={t('automod.alerts.channelLabel')}
            onChange={(e) => patch({ alertChannelId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{t('automod.alerts.nowhere')}</option>
            {textChannels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
          </select>
          <small className="muted">{t('automod.alerts.hint')}</small>
        </label>
      </div>

      <div className="automod-group">
        <h4>{t('automod.exemptions.title')}</h4>
        <p className="muted">{t('automod.exemptions.always')}</p>
        {roles.length > 0 && (
          <fieldset className="automod-chips">
            <legend>{t('automod.exemptions.roles')}</legend>
            {roles.map((r) => (
              <Chip key={r.id} on={c.exemptRoles.includes(r.id)} label={r.name}
                onToggle={(on) => patch({ exemptRoles: on ? [...c.exemptRoles, r.id] : c.exemptRoles.filter((id) => id !== r.id) })} />
            ))}
          </fieldset>
        )}
        <fieldset className="automod-chips">
          <legend>{t('automod.exemptions.channels')}</legend>
          {exemptable.map((ch) => (
            <Chip key={ch.id} on={c.exemptChannels.includes(ch.id)} label={`#${ch.name}`}
              onToggle={(on) => patch({ exemptChannels: on ? [...c.exemptChannels, ch.id] : c.exemptChannels.filter((id) => id !== ch.id) })} />
          ))}
        </fieldset>
      </div>

      <div className={`automod-save ${dirty || error || (built && 'problem' in built) ? 'show' : ''}`}>
        {built && 'problem' in built ? <span className="error-text">{built.problem}</span>
          : error ? <span className="error-text">{error}</span>
          : <span>{dirty ? t('automod.unsaved') : ''}</span>}
        <div className="copy-row">
          <button className="button ghost" disabled={!dirty || busy} onClick={() => { setDraft(toDraft(saved)); setError(null) }}>{t('common.undo')}</button>
          <button className="button primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? <Spinner /> : t('automod.saveChanges')}</button>
        </div>
      </div>
      {done && !dirty && <p className="muted" role="status">{t('automod.saved')}</p>}
    </section>
  )
}

function Rule({ title, hint, on, onToggle, children }: { title: string; hint: string; on: boolean; onToggle: (on: boolean) => void; children: ReactNode }) {
  return (
    <div className={`automod-rule ${on ? 'on' : ''}`}>
      <div className="internet-head">
        <div>
          <strong>{title}</strong>
          <p className="internet-summary">{hint}</p>
        </div>
        <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={title} onClick={() => onToggle(!on)}>
          <span />
        </button>
      </div>
      {on && <div className="automod-rule-body">{children}</div>}
    </div>
  )
}

function ActionRow({ action, canTimeout, alertsPossible, onChange }: {
  action: AutoModAction; canTimeout: boolean; alertsPossible: boolean; onChange: (a: AutoModAction) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="automod-actions">
      <span className="muted">{t('automod.action.lead')}</span>
      <label className="field inline">
        <select value={action.timeoutMs} disabled={!canTimeout && action.timeoutMs === 0} aria-label={t('automod.action.timeoutLabel')}
          title={canTimeout ? undefined : t('automod.action.cantTimeout')}
          onChange={(e) => onChange({ ...action, timeoutMs: Number(e.target.value) })}>
          <option value={0}>{t('automod.action.noTimeout')}</option>
          {TIMEOUT_OPTIONS.map((o) => <option key={o.ms} value={o.ms}>{t('automod.action.timeoutFor', { duration: durationLabel(o.ms) })}</option>)}
        </select>
      </label>
      <label className="checkbox" title={alertsPossible ? undefined : t('automod.action.pickChannel')}>
        <input type="checkbox" checked={action.alert} onChange={(e) => onChange({ ...action, alert: e.target.checked })} aria-label={t('automod.action.alertLabel')} />
        {alertsPossible ? t('automod.action.alert') : t('automod.action.alertNoChannel')}
      </label>
    </div>
  )
}

function NumberInput({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <input className="automod-number" type="number" inputMode="numeric" min={min} max={max} step={1} aria-label={label} value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (Number.isInteger(n) && n >= min && n <= max) onChange(n)
      }}
      onBlur={() => setText(String(value))} />
  )
}

function Chip({ on, label, onToggle }: { on: boolean; label: string; onToggle: (on: boolean) => void }) {
  return (
    <button type="button" className={`automod-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onToggle(!on)}>
      {on && <span aria-hidden>✓ </span>}{label}
    </button>
  )
}
