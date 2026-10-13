// Settings → Bots & webhooks → Outgoing (admins): the server POSTs chosen events, signed, to an address you pick.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { errorMessage, translatedServerMessage } from '../../i18n/errors'
import type { OutHook, OutHookDelivery, OutHookEvent } from '../../core/protocol'
import { connectionFor, type ServerState } from '../../state/store'
import { OUTHOOK_EVENTS, deliveryState, needsChannels, urlProblem } from '../../state/outhookRules'
import { useOuthookNotices } from '../../state/outhooks'
import { Spinner } from '../bits'
import { messageTime } from '../format'
import '../bots.css'
import '../outhooks.css'

export function OutgoingWebhooks({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const connection = connectionFor(server.key)
  const [hooks, setHooks] = useState<OutHook[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const reload = useCallback(() => {
    connection?.request('outhook.list', {}).then((r) => setHooks(r.hooks)).catch((e: Error) => setError(errorMessage(e)))
  }, [connection])
  // Again when one turns itself off, so it shows at once.
  const notices = useOuthookNotices((s) => s.notices.length)
  useEffect(reload, [reload, notices])

  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      setError(null)
      reload()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="outhooks" data-testid="outhooks">
      <p className="muted">{t('outhooks.intro')}</p>
      {secret && <SecretBox secret={secret} onDone={() => setSecret(null)} />}
      {hooks === null ? <Spinner /> : hooks.length === 0 ? <p className="empty-note">{t('outhooks.empty')}</p> : (
        <ul className="hook-list">
          {hooks.map((hook) => editing === hook.id ? (
            <li key={hook.id} className="hook outhook">
              <OutHookForm
                server={server}
                initial={hook}
                submitLabel={t('common.save')}
                onCancel={() => setEditing(null)}
                onSubmit={async (values) => {
                  await connection!.request('outhook.update', { id: hook.id, ...values })
                  setEditing(null)
                  reload()
                }}
              />
            </li>
          ) : (
            <OutHookRow
              key={hook.id}
              server={server}
              hook={hook}
              onEdit={() => setEditing(hook.id)}
              run={run}
              onSecret={setSecret}
            />
          ))}
        </ul>
      )}
      {editing === null && (
        <section className="settings-section">
          <h3>{t('outhooks.new')}</h3>
          <OutHookForm
            server={server}
            submitLabel={t('outhooks.create')}
            onSubmit={async (values) => {
              const r = await connection!.request('outhook.create', values)
              setSecret(r.secret)
              reload()
            }}
          />
        </section>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
}

function SecretBox({ secret, onDone }: { secret: string; onDone: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="secret-box" role="status" data-testid="outhook-secret">
      <p>{t('outhooks.secretNow')}</p>
      <div className="copy-row">
        <input readOnly value={secret} aria-label={t('outhooks.secretLabel')} onFocus={(e) => e.target.select()} />
        <button className="button primary" onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true))}>
          {copied ? t('settings.recovery.copied') : t('common.copy')}
        </button>
        <button className="button" onClick={onDone}>{t('common.done')}</button>
      </div>
      <small className="muted">{t('outhooks.verifyHelp')}</small>
    </div>
  )
}

function outcomeText(t: TFunction, d: Pick<OutHookDelivery, 'outcome' | 'status'>): string {
  return t(`outhooks.outcome.${d.outcome}`, { status: d.status ?? '' })
}

function OutHookRow({ server, hook, onEdit, run, onSecret }: {
  server: ServerState
  hook: OutHook
  onEdit: () => void
  run: (action: () => Promise<unknown>) => Promise<void>
  onSecret: (secret: string) => void
}) {
  const { t } = useTranslation()
  const connection = connectionFor(server.key)!
  const [log, setLog] = useState<OutHookDelivery[] | null>(null)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<OutHookDelivery | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function loadLog() {
    const r = await connection.request('outhook.log', { id: hook.id })
    setLog(r.deliveries)
  }

  async function test() {
    setTesting(true)
    try {
      const r = await connection.request('outhook.test', { id: hook.id })
      setTested(r.delivery)
      if (log) await loadLog()
    } finally {
      setTesting(false)
    }
  }

  const channelNames = hook.channelIds.map((id) => server.channels.find((c) => c.id === id)?.name).filter(Boolean)
  const status = hook.enabled
    ? hook.lastDeliveryAt ? t('outhooks.lastDelivery', { when: messageTime(hook.lastDeliveryAt) }) : t('outhooks.never')
    : hook.disabledReason === 'failures' ? t('outhooks.offFailures', { count: hook.failures }) : t('outhooks.offByAdmin')

  return (
    <li className={`hook outhook${hook.enabled ? '' : ' off'}`} data-testid="outhook" data-hook={hook.name}>
      <span className={`outhook-dot ${hook.enabled ? 'on' : 'off'}`} aria-hidden="true" />
      <span className="hook-name">{hook.name} <span className="outhook-host">{hook.host}</span></span>
      <span className="hook-meta">
        {hook.events.map((e) => t(`outhooks.event.${e}`)).join(' · ')}
        {channelNames.length > 0 && ` · ${channelNames.map((n) => `#${n}`).join(', ')}`}
        {hook.allowLocal && ` · ${t('outhooks.local')}`}
        <br />
        <span className={hook.enabled ? '' : 'outhook-off-text'} data-testid="outhook-status">{status}</span>
      </span>
      {tested && (
        <p className={`outhook-test ${tested.outcome === 'ok' ? 'ok' : 'bad'}`} role="status" data-testid="outhook-test-result">
          {tested.outcome === 'ok'
            ? t('outhooks.testOk', { status: tested.status ?? '', ms: tested.ms })
            : t('outhooks.testFailed', { reason: outcomeText(t, tested) })}
        </p>
      )}
      {confirmDelete ? (
        <div className="hook-actions">
          <span>{t('outhooks.deleteConfirm', { name: hook.name, host: hook.host })}</span>
          <button className="button danger" onClick={() => void run(() => connection.request('outhook.delete', { id: hook.id }))}>{t('common.delete')}</button>
          <button className="button" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
        </div>
      ) : (
        <div className="hook-actions">
          <button className="button" disabled={testing} onClick={() => void run(test)}>{testing ? t('outhooks.testing') : t('outhooks.test')}</button>
          <button className="button" aria-expanded={log !== null} onClick={() => (log ? setLog(null) : void run(loadLog))}>{log ? t('outhooks.hideLog') : t('outhooks.log')}</button>
          <button className="button" onClick={onEdit}>{t('common.edit')}</button>
          <button className="button" onClick={() => void run(() => connection.request('outhook.update', { id: hook.id, enabled: !hook.enabled }))}>
            {hook.enabled ? t('outhooks.turnOff') : t('outhooks.turnOn')}
          </button>
          <button
            className="button"
            title={t('outhooks.newSecretHint')}
            onClick={() => void run(async () => onSecret((await connection.request('outhook.regenerate', { id: hook.id })).secret))}
          >
            {t('outhooks.newSecret')}
          </button>
          <button className="button danger-outline" onClick={() => setConfirmDelete(true)}>{t('common.delete')}</button>
        </div>
      )}
      {log && (
        <div className="outhook-log" data-testid="outhook-log">
          <small className="muted">{t('outhooks.logIntro')}</small>
          {log.length === 0 ? <p className="empty-note">{t('outhooks.logEmpty')}</p> : (
            <ol>
              {log.map((d, i) => (
                <li key={`${d.delivery}-${d.attempt}-${i}`} className={deliveryState(d)}>
                  <span className="outhook-log-when">{messageTime(d.at)}</span>
                  <span>{t(`outhooks.event.${d.event}`)}</span>
                  <span>{d.outcome === 'ok' ? `${d.status} · ${d.ms} ms` : outcomeText(t, d)}{d.attempt > 1 ? ` · ${t('outhooks.attempt', { n: d.attempt })}` : ''}</span>
                  <span className="outhook-log-state">{t(`outhooks.state.${deliveryState(d)}`)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  )
}

interface Values {
  name: string
  url: string
  events: OutHookEvent[]
  channelIds: number[]
  allowLocal: boolean
}

function OutHookForm({ server, initial, submitLabel, onSubmit, onCancel }: {
  server: ServerState
  initial?: OutHook
  submitLabel: string
  onSubmit: (values: Values) => Promise<void>
  onCancel?: () => void
}) {
  const { t } = useTranslation()
  const isOwner = server.me?.role === 'owner'
  const channels = server.channels.filter((c) => (c.kind === 'text' || c.kind === 'voice' || c.kind === 'stage' || c.kind === 'forum') && !c.e2ee)
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [events, setEvents] = useState<OutHookEvent[]>(initial?.events ?? ['message.created'])
  const [channelIds, setChannelIds] = useState<number[]>(initial?.channelIds ?? (channels[0] ? [channels[0].id] : []))
  const [allowLocal, setAllowLocal] = useState(initial?.allowLocal ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const problem = url.trim() ? urlProblem(url, allowLocal) : null
  const wantsChannels = needsChannels(events)
  const ready = name.trim() && url.trim() && !problem && events.length > 0 && (!wantsChannels || channelIds.length > 0)

  function toggle<T>(list: T[], item: T, on: boolean): T[] {
    return on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item)
  }

  async function submit() {
    if (!ready || busy) return
    setBusy(true)
    try {
      await onSubmit({ name: name.trim(), url: url.trim(), events, channelIds: wantsChannels ? channelIds : [], allowLocal })
      if (!initial) {
        setName('')
        setUrl('')
      }
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="outhook-form">
      <label className="field">
        <span>{t('outhooks.name')}</span>
        <input value={name} maxLength={32} placeholder={t('outhooks.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('outhooks.url')}</span>
        <input
          value={url}
          maxLength={512}
          type="url"
          inputMode="url"
          spellCheck={false}
          placeholder={t('outhooks.urlPlaceholder')}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={problem ? true : undefined}
        />
        {problem && <small className="error-text">{translatedServerMessage(problem, { max: 10 })}</small>}
      </label>
      <fieldset className="outhook-choices">
        <legend>{t('outhooks.events')}</legend>
        {OUTHOOK_EVENTS.map((e) => (
          <label key={e} className="checkbox">
            <input type="checkbox" checked={events.includes(e)} onChange={(ev) => setEvents(toggle(events, e, ev.target.checked))} />
            {t(`outhooks.event.${e}`)}
          </label>
        ))}
      </fieldset>
      {wantsChannels && (
        <fieldset className="outhook-choices">
          <legend>{t('outhooks.channels')}</legend>
          <small className="muted">{t('outhooks.channelsHint')}</small>
          {channels.length === 0 ? <p className="empty-note">{t('outhooks.noChannels')}</p> : (
            <div className="outhook-channels">
              {channels.map((c) => (
                <label key={c.id} className="checkbox">
                  <input type="checkbox" checked={channelIds.includes(c.id)} onChange={(ev) => setChannelIds(toggle(channelIds, c.id, ev.target.checked))} />
                  #{c.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={allowLocal} disabled={!isOwner && !allowLocal} onChange={(e) => setAllowLocal(e.target.checked)} />
        <span>
          {t('outhooks.allowLocal')}
          <br /><small className="muted">{isOwner ? t('outhooks.allowLocalHint') : t('outhooks.allowLocalOwner')}</small>
        </span>
      </label>
      <div className="copy-row">
        <button className="button primary" disabled={!ready || busy} onClick={() => void submit()}>{busy ? <Spinner /> : submitLabel}</button>
        {onCancel && <button className="button" onClick={onCancel}>{t('common.cancel')}</button>}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
}
