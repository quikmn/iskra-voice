// Server settings → Bots → Feeds: what the Feeds bot follows (RSS/Atom, YouTube, Twitch) and where it posts. Admins
// only; the Twitch app (client id and secret) is the owner's to add. Loaded when opened.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedFields, FeedKind, FeedReply, FeedSubscription, FeedTwitch, ServerRole } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { addFeed, checkFeed, getFeeds, removeFeed, setTwitchApp, updateFeed } from '../../state/feeds'
import {
  FEED_INTERVALS, FEED_KINDS, MAX_FEED_SOURCE, MAX_FEED_TEMPLATE, feedStatus, fieldsOf, fieldsPatch, fieldsProblem, fillFeedTemplate, guessKind,
  mentionValue, parseMentionValue, safeUrl, sourceProblem,
} from '../../state/feedsLogic'
import { canMentionRole, canPingGroups } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import type { ServerState } from '../../state/store'
import { FeedPost } from '../chat/FeedPost'
import { relativeTime } from '../chat/pinThreadHelpers'
import '../moreBots.css'
import '../feeds.css'

type Data = { subscriptions: FeedSubscription[]; twitch: FeedTwitch; max: number }
type Status = { kind: 'ok' | 'error'; text: string } | null

export function FeedSettings({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    getFeeds(server.key).then((d) => live && setData(d), (e) => live && setError(errorMessage(e)))
    return () => { live = false }
  }, [server.key])

  if (!data) return <p className="muted more-bot-settings">{error ?? t('feeds.settings.loading')}</p>

  const replace = (sub: FeedSubscription) => setData({ ...data, subscriptions: data.subscriptions.map((s) => (s.id === sub.id ? sub : s)) })
  const owner = server.me?.role === 'owner'
  return (
    <div className="more-bot-settings feed-settings" data-testid="feeds-settings">
      <p className="muted small">{t('feeds.settings.intro')}</p>
      <p className="muted small feed-privacy">{t('feeds.settings.privacy')}</p>
      <p className="small feed-count">{t('feeds.settings.count', { count: data.subscriptions.length, max: data.max })}</p>
      {data.subscriptions.length === 0 ? (
        <p className="empty-note">{t('feeds.settings.empty')}</p>
      ) : (
        <ul className="feed-list">
          {data.subscriptions.map((sub) => (
            <FeedRow key={sub.id} server={server} sub={sub} onChange={replace}
              onRemoved={() => setData({ ...data, subscriptions: data.subscriptions.filter((s) => s.id !== sub.id) })} />
          ))}
        </ul>
      )}
      {data.subscriptions.length < data.max && (
        <AddFeed server={server} twitch={data.twitch} onAdded={(sub) => setData({ ...data, subscriptions: [...data.subscriptions, sub] })} />
      )}
      {owner && <TwitchApp server={server} twitch={data.twitch} onChange={(twitch) => setData({ ...data, twitch })} />}
    </div>
  )
}

// ── One feed ─────────────────────────────────────────────────────────────

function FeedRow({ server, sub, onChange, onRemoved }: { server: ServerState; sub: FeedSubscription; onChange: (s: FeedSubscription) => void; onRemoved: () => void }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const channel = server.channels.find((c) => c.id === sub.channelId)
  const link = safeUrl(sub.url)

  async function run(work: () => Promise<void>, done?: string) {
    setBusy(true)
    setStatus(null)
    try {
      await work()
      if (done) setStatus({ kind: 'ok', text: done })
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  const state = feedStatus(sub)
  const when = (ms: number | null) => (ms ? relativeTime(ms) : '')
  const line = state === 'error'
    ? t('feeds.settings.status.error', { when: when(sub.lastCheckAt), reason: t(`feeds.settings.error.${sub.lastError}` as never) })
    : state === 'ok' ? t('feeds.settings.status.ok', { when: when(sub.lastCheckAt) }) : t(`feeds.settings.status.${state}` as never)

  return (
    <li className={`feed-item ${sub.paused ? 'paused' : ''}`} data-testid="feed-item">
      <div className="feed-head">
        <span className={`feed-kind feed-kind-${sub.kind}`}>{t(`feeds.settings.kind.${sub.kind}` as never)}</span>
        {link ? <a className="feed-name" href={link} target="_blank" rel="noopener noreferrer">{sub.name}</a> : <span className="feed-name">{sub.name}</span>}
      </div>
      <p className="muted small feed-meta">
        {t('feeds.settings.where', { channel: channel?.name ?? t('feeds.settings.unknownChannel') })}
        {' · '}{t('feeds.settings.every', { count: sub.intervalMinutes })}
        {sub.lastPostAt ? <>{' · '}{t('feeds.settings.lastPost', { when: relativeTime(sub.lastPostAt) })}</> : null}
      </p>
      <p className={`small feed-status ${state}`} role="status">{line}</p>
      {sub.mention && !sub.canPing && <p className="small feed-warning">{t('feeds.settings.cantPing')}</p>}
      {editing ? (
        <EditFeed server={server} sub={sub} onDone={(next) => { if (next) onChange(next); setEditing(false) }} />
      ) : confirm ? (
        <div className="more-bot-actions">
          <span className="small">{t('feeds.settings.removeConfirm', { name: sub.name })}</span>
          <button type="button" className="button danger small" disabled={busy} onClick={() => void run(async () => { await removeFeed(server.key, sub.id); onRemoved() })}>
            {t('feeds.settings.remove')}
          </button>
          <button type="button" className="button small" onClick={() => setConfirm(false)}>{t('feeds.settings.cancel')}</button>
        </div>
      ) : (
        <div className="more-bot-actions feed-actions">
          <button type="button" className="button small" disabled={busy} data-testid="feed-check"
            onClick={() => void run(async () => onChange(await checkFeed(server.key, sub.id)), t('feeds.settings.checked'))}>
            {t('feeds.settings.check')}
          </button>
          <button type="button" className="button small" disabled={busy} onClick={() => setEditing(true)}>{t('feeds.settings.edit')}</button>
          <button type="button" className="button small" disabled={busy}
            onClick={() => void run(async () => onChange(await updateFeed(server.key, sub.id, { paused: !sub.paused })))}>
            {sub.paused ? t('feeds.settings.resume') : t('feeds.settings.pause')}
          </button>
          <button type="button" className="button small" disabled={busy} onClick={() => setConfirm(true)}>{t('feeds.settings.remove')}</button>
        </div>
      )}
      {status && <p className={`small ${status.kind === 'error' ? 'error-text' : 'muted'}`} role="status">{status.text}</p>}
    </li>
  )
}

function EditFeed({ server, sub, onDone }: { server: ServerState; sub: FeedSubscription; onDone: (s: FeedSubscription | null) => void }) {
  const { t } = useTranslation()
  const saved = fieldsOf(sub)
  const [draft, setDraft] = useState<FeedFields>(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const patch = fieldsPatch(saved, draft)
  const problem = fieldsProblem(sub.kind, draft)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      onDone(await updateFeed(server.key, sub.id, patch))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <form className="feed-edit" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <Fields server={server} kind={sub.kind} name={sub.name} draft={draft} setDraft={setDraft} busy={busy} idPrefix={`feed-${sub.id}`} />
      {problem && <p className="error-text small">{problemText(t, sub.kind, problem)}</p>}
      <div className="more-bot-actions">
        <button type="submit" className="button primary small" disabled={busy || !!problem || Object.keys(patch).length === 0}>{t('feeds.settings.save')}</button>
        <button type="button" className="button small" onClick={() => onDone(null)}>{t('feeds.settings.cancel')}</button>
        {error && <span className="error-text small" role="alert">{error}</span>}
      </div>
    </form>
  )
}

type T = ReturnType<typeof useTranslation>['t']

function problemText(t: T, kind: FeedKind, problem: string): string {
  const { min, max } = FEED_INTERVALS[kind]
  return String(t(`feeds.settings.invalid.${problem}` as never, { min, max: problem === 'template' ? MAX_FEED_TEMPLATE : max } as never))
}

// ── The fields every feed has ────────────────────────────────────────────

function Fields({ server, kind, name, draft, setDraft, busy, idPrefix }: {
  server: ServerState; kind: FeedKind; name: string; draft: FeedFields; setDraft: (f: FeedFields) => void; busy: boolean; idPrefix: string
}) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const me = server.me ?? undefined
  const channels = server.channels.filter((c) => c.kind === 'text' && !c.e2ee).sort((a, b) => a.position - b.position)
  const groups = canPingGroups(me, roles, false)
  // Roles this admin may mention, plus whatever is picked now (an owner may have picked it).
  const mentionable = roles.filter((r: ServerRole) => canMentionRole(me, r, roles) || (draft.mention === 'role' && draft.mentionRoleId === r.id))
  const [custom, setCustom] = useState(draft.template.trim().length > 0)
  const { min, max } = FEED_INTERVALS[kind]
  const update = (more: Partial<FeedFields>) => setDraft({ ...draft, ...more })
  const example: FeedReply = {
    kind: 'feed.item', source: kind, subscriptionId: 0, name, title: t('feeds.post.example'), url: 'https://example.com/post',
    mention: draft.mention, mentionRoleId: draft.mentionRoleId,
    text: draft.template.trim() ? fillFeedTemplate(draft.template.trim(), { title: t('feeds.post.example'), url: 'https://example.com/post', name }) : null,
  }
  if (example.text !== null && draft.mention) {
    const token = draft.mention === 'role' ? `<@&${draft.mentionRoleId}>` : `@${draft.mention}`
    example.text = `${token} ${example.text}`
  }

  return (
    <div className="feed-fields">
      <div className="more-bot-row">
        <label className="field">
          <span>{t('feeds.settings.channel')}</span>
          <select value={draft.channelId || ''} disabled={busy} required onChange={(e) => update({ channelId: Number(e.target.value) })} data-testid={`${idPrefix}-channel`}>
            {!draft.channelId && <option value="" />}
            {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t('feeds.settings.mention')}</span>
          <select value={mentionValue(draft.mention, draft.mentionRoleId)} disabled={busy} onChange={(e) => update(parseMentionValue(e.target.value))}>
            <option value="">{t('feeds.settings.mentionNone')}</option>
            {(groups || draft.mention === 'everyone') && <option value="everyone">@everyone</option>}
            {(groups || draft.mention === 'here') && <option value="here">@here</option>}
            {mentionable.map((r) => <option key={r.id} value={`role:${r.id}`}>@{r.name}</option>)}
          </select>
        </label>
        <label className="field feed-interval">
          <span>{t('feeds.settings.interval')}</span>
          <input type="number" inputMode="numeric" min={min} max={max} value={Number.isNaN(draft.intervalMinutes) ? '' : draft.intervalMinutes} disabled={busy}
            onChange={(e) => update({ intervalMinutes: e.target.value === '' ? NaN : Number(e.target.value) })} />
        </label>
      </div>
      <p className="muted small">{t('feeds.settings.intervalHint', { min, max })}{draft.mention ? ` · ${t('feeds.settings.mentionHint')}` : ''}</p>
      {custom ? (
        <>
          <label className="field">
            <span>{t('feeds.settings.template')}</span>
            <textarea rows={2} maxLength={MAX_FEED_TEMPLATE} value={draft.template} disabled={busy} placeholder={t('feeds.settings.templatePlaceholder')}
              aria-describedby={`${idPrefix}-template-hint`} onChange={(e) => update({ template: e.target.value })} />
          </label>
          <p id={`${idPrefix}-template-hint`} className="muted small">{t('feeds.settings.templateHint')}</p>
        </>
      ) : (
        <button type="button" className="link small feed-customize" onClick={() => setCustom(true)}>{t('feeds.settings.customize')}</button>
      )}
      <div className="welcome-preview feed-preview" aria-label={t('feeds.settings.preview')}>
        <span className="muted small">{t('feeds.settings.preview')}</span>
        <FeedPost server={server} reply={example} />
      </div>
    </div>
  )
}

// ── Adding ───────────────────────────────────────────────────────────────

function AddFeed({ server, twitch, onAdded }: { server: ServerState; twitch: FeedTwitch; onAdded: (s: FeedSubscription) => void }) {
  const { t } = useTranslation()
  const firstChannel = server.channels.filter((c) => c.kind === 'text' && !c.e2ee).sort((a, b) => a.position - b.position)[0]
  const [kind, setKind] = useState<FeedKind>('rss')
  const [source, setSource] = useState('')
  const [draft, setDraft] = useState<FeedFields>({ channelId: firstChannel?.id ?? 0, mention: null, mentionRoleId: null, template: '', intervalMinutes: FEED_INTERVALS.rss.default })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [touched, setTouched] = useState(false)
  const sourceIssue = sourceProblem(kind, source)
  const fieldIssue = fieldsProblem(kind, draft)
  const blocked = kind === 'twitch' && !twitch.configured
  const owner = server.me?.role === 'owner'

  function pick(next: FeedKind) {
    setKind(next)
    setStatus(null)
    setDraft({ ...draft, intervalMinutes: FEED_INTERVALS[next].default })
  }

  async function add() {
    setTouched(true)
    if (sourceIssue || fieldIssue || blocked) return
    setBusy(true)
    setStatus({ kind: 'ok', text: t('feeds.settings.adding') })
    try {
      const sub = await addFeed(server.key, kind, source, draft)
      onAdded(sub)
      setSource('')
      setTouched(false)
      setStatus({ kind: 'ok', text: t('feeds.settings.added') })
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="feed-add" data-testid="feed-add" onSubmit={(e) => { e.preventDefault(); void add() }}>
      <h4 className="feed-add-title">{t('feeds.settings.addTitle')}</h4>
      <div className="segmented feed-kinds" role="radiogroup" aria-label={t('feeds.settings.kindLabel')}>
        {FEED_KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} disabled={busy} onClick={() => pick(k)}
            data-testid={`feed-kind-${k}`}>
            {t(`feeds.settings.kind.${k}` as never)}
          </button>
        ))}
      </div>
      {blocked ? (
        <p className="muted small feed-warning">{owner ? t('feeds.settings.twitch.needed') : t('feeds.settings.twitch.neededMember')}</p>
      ) : (
        <>
          <label className="field">
            <span>{t(`feeds.settings.source.${kind}` as never)}</span>
            <input type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={MAX_FEED_SOURCE} value={source} disabled={busy}
              placeholder={t(`feeds.settings.placeholder.${kind}` as never)} aria-describedby="feed-source-hint" data-testid="feed-source"
              onChange={(e) => {
                setSource(e.target.value)
                setStatus(null)
                // A pasted YouTube or Twitch address switches to that kind.
                const guess = guessKind(e.target.value)
                if (guess !== 'rss' && guess !== kind && source.trim() === '') pick(guess)
              }} />
          </label>
          <p id="feed-source-hint" className="muted small">{t(`feeds.settings.hint.${kind}` as never)}</p>
          {touched && sourceIssue && <p className="error-text small">{t(`feeds.settings.invalid.${sourceIssue}` as never)}</p>}
          <Fields server={server} kind={kind} name={t('feeds.post.exampleName')} draft={draft} setDraft={setDraft} busy={busy} idPrefix="feed-new" />
          {touched && fieldIssue && <p className="error-text small">{problemText(t, kind, fieldIssue)}</p>}
          <div className="more-bot-actions">
            <button type="submit" className="button primary small" disabled={busy} data-testid="feed-add-submit">{t('feeds.settings.add')}</button>
            {status && <span className={`small ${status.kind === 'error' ? 'error-text' : 'muted'}`} role="status" data-testid="feed-add-status">{status.text}</span>}
          </div>
        </>
      )}
    </form>
  )
}

// ── The owner's Twitch app ───────────────────────────────────────────────

function TwitchApp({ server, twitch, onChange }: { server: ServerState; twitch: FeedTwitch; onChange: (t: FeedTwitch) => void }) {
  const { t } = useTranslation()
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  async function save(id: string, key: string, done: string) {
    setBusy(true)
    setStatus(null)
    try {
      onChange(await setTwitchApp(server.key, id, key))
      setClientId('')
      setSecret('')
      setStatus({ kind: 'ok', text: done })
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="feed-twitch" data-testid="feed-twitch">
      <summary>{t('feeds.settings.twitch.title')}</summary>
      {twitch.configured ? (
        <div className="more-bot-actions">
          <span className="small">{t('feeds.settings.twitch.connected', { id: twitch.clientId ?? '' })}</span>
          <button type="button" className="button small" disabled={busy} onClick={() => void save('', '', t('feeds.settings.twitch.removed'))}>{t('feeds.settings.twitch.remove')}</button>
        </div>
      ) : (
        <form className="feed-twitch-form" onSubmit={(e) => { e.preventDefault(); void save(clientId, secret, t('feeds.settings.twitch.saved')) }}>
          <p className="muted small">{t('feeds.settings.twitch.needed')} {t('feeds.settings.twitch.steps')}</p>
          <a className="small" href="https://dev.twitch.tv/console/apps" target="_blank" rel="noopener noreferrer">{t('feeds.settings.twitch.open')}</a>
          <div className="more-bot-row">
            <label className="field">
              <span>{t('feeds.settings.twitch.clientId')}</span>
              <input type="text" autoComplete="off" spellCheck={false} maxLength={64} value={clientId} disabled={busy} onChange={(e) => setClientId(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('feeds.settings.twitch.clientSecret')}</span>
              <input type="password" autoComplete="new-password" spellCheck={false} maxLength={64} value={secret} disabled={busy} onChange={(e) => setSecret(e.target.value)} />
            </label>
          </div>
          <div className="more-bot-actions">
            <button type="submit" className="button primary small" disabled={busy || !clientId.trim() || !secret.trim()}>{t('feeds.settings.twitch.save')}</button>
          </div>
        </form>
      )}
      {status && <p className={`small ${status.kind === 'error' ? 'error-text' : 'muted'}`} role="status">{status.text}</p>}
    </details>
  )
}
