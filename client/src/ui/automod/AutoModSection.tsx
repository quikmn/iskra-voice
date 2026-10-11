// Settings → AutoMod (admins, or a role that manages AutoMod): rules the server applies before a message is stored.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AutoModAction, AutoModConfig } from '../../core/protocol'
import {
  activeRules, AUTOMOD_LIMITS, parseDomains, parseList, suggestedAutoMod, wordListProblem,
} from '../../state/automod'
import { TIMEOUT_OPTIONS } from '../../state/moderationRules'
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
      .catch((e: Error) => setError(e.message))
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
    if (bad) return { problem: `"${bad}" isn't a domain like example.com.` }
    if (domains.length > AUTOMOD_LIMITS.domains) return { problem: `Up to ${AUTOMOD_LIMITS.domains} allowed domains.` }
    const c = draft.config
    return { config: { ...c, words: { ...c.words, blocked, allowed }, links: { ...c.links, allowedDomains: domains } } }
  }, [draft])

  if (!draft || !saved) {
    return (
      <section className="settings-section automod" data-testid="automod-section">
        <h3>AutoMod</h3>
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
      setError((e as Error).message)
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
      <h3>AutoMod</h3>
      <p className="muted">
        Rules this server checks before a message is posted. A blocked message is never saved or shown to anyone; the sender sees why.
        Admins and the owner are never blocked.
      </p>

      <div className="internet-head automod-master">
        <div>
          <strong>AutoMod is {c.enabled ? 'on' : 'off'}</strong>
          <p className="internet-summary">
            {c.enabled
              ? active.length ? `${active.length} ${active.length === 1 ? 'rule' : 'rules'} on.` : 'No rules are on yet.'
              : 'Nothing is checked until you turn it on.'}
          </p>
        </div>
        <button className={`switch ${c.enabled ? 'on' : ''}`} role="switch" aria-checked={c.enabled} aria-label="AutoMod"
          onClick={() => patch({ enabled: !c.enabled })}>
          <span />
        </button>
      </div>
      <div className="automod-preset">
        <button className="button small" onClick={() => setDraft((d) => d && {
          ...d, config: suggestedAutoMod(d.config, canTimeout, d.config.alertChannelId ?? null),
        })}>Use suggested settings</button>
        <span className="muted">Turns on spam protection and blocks invites to other servers. Save to apply.</span>
      </div>
      <p className="automod-note muted">
        Direct messages and groups are end-to-end encrypted, so the server can't read them and AutoMod doesn't apply there.
      </p>

      <Rule title="Blocked words" hint="Whole words, ignoring case, accents and look-alike letters. Use * for any letters: bad* also blocks badly."
        on={c.words.enabled} onToggle={(on) => rule('words', { enabled: on })}>
        <label className="field">
          <span>Blocked words and phrases (one per line) · {parseList(draft.blocked).length}/{AUTOMOD_LIMITS.blocked}</span>
          <textarea rows={5} value={draft.blocked} spellCheck={false} aria-label="Blocked words and phrases"
            onChange={(e) => setDraft({ ...draft, blocked: e.target.value })} placeholder={'badword\nbad*\nsome phrase'} />
        </label>
        <label className="field">
          <span>Allowed anyway (optional)</span>
          <textarea rows={2} value={draft.allowed} spellCheck={false} aria-label="Allowed words"
            onChange={(e) => setDraft({ ...draft, allowed: e.target.value })} placeholder="Words a wildcard shouldn't catch" />
        </label>
        {action('words')}
      </Rule>

      <Rule title="Mention spam" hint="Too many people or roles mentioned in one message (@everyone and @here count once)."
        on={c.mentions.enabled} onToggle={(on) => rule('mentions', { enabled: on })}>
        <div className="automod-inline">
          <span>Block more than</span>
          <NumberInput label="Most mentions" value={c.mentions.max} min={1} max={50} onChange={(max) => rule('mentions', { max })} />
          <span>mentions in a message</span>
        </div>
        {action('mentions')}
      </Rule>

      <Rule title="Sending too fast" hint="Counts every new message from one person, in all channels."
        on={c.flood.enabled} onToggle={(on) => rule('flood', { enabled: on })}>
        <div className="automod-inline">
          <span>Block after</span>
          <NumberInput label="Messages" value={c.flood.count} min={2} max={50} onChange={(count) => rule('flood', { count })} />
          <span>messages in</span>
          <NumberInput label="Seconds" value={c.flood.seconds} min={2} max={120} onChange={(seconds) => rule('flood', { seconds })} />
          <span>seconds</span>
        </div>
        {action('flood')}
      </Rule>

      <Rule title="Repeated messages" hint="The same text again and again."
        on={c.duplicates.enabled} onToggle={(on) => rule('duplicates', { enabled: on })}>
        <div className="automod-inline">
          <span>Block after</span>
          <NumberInput label="Repeats" value={c.duplicates.count} min={1} max={20} onChange={(count) => rule('duplicates', { count })} />
          <span>identical messages in</span>
          <NumberInput label="Repeat seconds" value={c.duplicates.seconds} min={5} max={3600} onChange={(seconds) => rule('duplicates', { seconds })} />
          <span>seconds</span>
        </div>
        {action('duplicates')}
      </Rule>

      <Rule title="Links" hint="Invite links to other servers, or every link except the sites you allow."
        on={c.links.enabled} onToggle={(on) => rule('links', { enabled: on })}>
        <div className="automod-radios" role="radiogroup" aria-label="Which links">
          <label className="checkbox">
            <input type="radio" name={`links-${server.key}`} checked={c.links.mode === 'invites'} onChange={() => rule('links', { mode: 'invites' })} />
            Only invite links (Discord and other Iskra servers)
          </label>
          <label className="checkbox">
            <input type="radio" name={`links-${server.key}`} checked={c.links.mode === 'all'} onChange={() => rule('links', { mode: 'all' })} />
            All links
          </label>
        </div>
        {c.links.mode === 'all' && (
          <label className="field">
            <span>Allowed sites (one per line)</span>
            <textarea rows={2} value={draft.domains} spellCheck={false} aria-label="Allowed sites"
              onChange={(e) => setDraft({ ...draft, domains: e.target.value })} placeholder={'youtube.com\ngithub.com'} />
          </label>
        )}
        {action('links')}
      </Rule>

      <div className="automod-group">
        <h4>Alerts</h4>
        <label className="field">
          <span>Post alerts in</span>
          <select value={c.alertChannelId ?? ''} aria-label="Alert channel"
            onChange={(e) => patch({ alertChannelId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Nowhere</option>
            {textChannels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
          </select>
          <small className="muted">
            Pick a channel only moderators can read. Blocked words are masked and the text is hidden until clicked; nothing from a channel
            its readers can't see is shown.
          </small>
        </label>
      </div>

      <div className="automod-group">
        <h4>Exemptions</h4>
        <p className="muted">Admins and the owner are always exempt.</p>
        {roles.length > 0 && (
          <fieldset className="automod-chips">
            <legend>Roles</legend>
            {roles.map((r) => (
              <Chip key={r.id} on={c.exemptRoles.includes(r.id)} label={r.name}
                onToggle={(on) => patch({ exemptRoles: on ? [...c.exemptRoles, r.id] : c.exemptRoles.filter((id) => id !== r.id) })} />
            ))}
          </fieldset>
        )}
        <fieldset className="automod-chips">
          <legend>Channels (and their threads)</legend>
          {exemptable.map((ch) => (
            <Chip key={ch.id} on={c.exemptChannels.includes(ch.id)} label={`#${ch.name}`}
              onToggle={(on) => patch({ exemptChannels: on ? [...c.exemptChannels, ch.id] : c.exemptChannels.filter((id) => id !== ch.id) })} />
          ))}
        </fieldset>
      </div>

      <div className={`automod-save ${dirty || error || (built && 'problem' in built) ? 'show' : ''}`}>
        {built && 'problem' in built ? <span className="error-text">{built.problem}</span>
          : error ? <span className="error-text">{error}</span>
          : <span>{dirty ? 'You have unsaved changes.' : ''}</span>}
        <div className="copy-row">
          <button className="button ghost" disabled={!dirty || busy} onClick={() => { setDraft(toDraft(saved)); setError(null) }}>Undo</button>
          <button className="button primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? <Spinner /> : 'Save changes'}</button>
        </div>
      </div>
      {done && !dirty && <p className="muted" role="status">Saved.</p>}
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
  return (
    <div className="automod-actions">
      <span className="muted">Block the message, and</span>
      <label className="field inline">
        <select value={action.timeoutMs} disabled={!canTimeout && action.timeoutMs === 0} aria-label="Timeout"
          title={canTimeout ? undefined : "You can't time people out, so AutoMod can't either."}
          onChange={(e) => onChange({ ...action, timeoutMs: Number(e.target.value) })}>
          <option value={0}>don't time them out</option>
          {TIMEOUT_OPTIONS.map((o) => <option key={o.ms} value={o.ms}>time them out for {o.label}</option>)}
        </select>
      </label>
      <label className="checkbox" title={alertsPossible ? undefined : 'Choose an alert channel below first.'}>
        <input type="checkbox" checked={action.alert} onChange={(e) => onChange({ ...action, alert: e.target.checked })} aria-label="Send an alert" />
        send an alert{alertsPossible ? '' : ' (choose a channel below)'}
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
