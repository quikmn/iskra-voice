// Settings → Backup & move (owner): "Backup buddies" (our daily backups at friends' servers, encrypted here first) and
// "Keep backups for a friend" (spots on this server for friends' servers). See "Backup buddies" in PROTOCOL.md.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage, translatedServerMessage } from '../../i18n/errors'
import { formatBytes, formatDate, formatNumber } from '../../i18n/format'
import { t as i18nT } from '../../i18n'
import type { Buddy, BuddyProblem, BuddySpot } from '../../core/protocol'
import {
  addBuddy, backupNow, buddyState, createSpot, loadBuddies, loadSpots, pairingCodeAddress, QUOTA_CHOICES_MB, removeBuddy,
  removeSpot, showRecoveryCode, spotUsage, useBuddies,
} from '../../state/buddies'
import type { ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './buddies.css'

/** A quota: whole gigabytes without decimals ("2 GB", not "2.0 GB"). */
const quotaText = (bytes: number) => bytes % 2 ** 30 === 0 ? `${formatNumber(bytes / 2 ** 30)} GB` : formatBytes(bytes)

const when = (ms: number) => formatDate(ms, { dateStyle: 'medium', timeStyle: 'short' })

/** A problem in the app's language; a too-big backup in readable sizes. */
function problemText(problem: BuddyProblem): string {
  if (problem.key === 'buddy_too_big' && problem.args) {
    return i18nT('buddies.tooBig', { size: formatBytes(Number(problem.args.size)), quota: formatBytes(Number(problem.args.quota)) })
  }
  return (problem.key && translatedServerMessage(problem.key, problem.args ?? {})) || problem.message
}

/** Copies text, and says so for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <button type="button" className="button" onClick={() => void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }, () => undefined)}>
      {copied ? t('buddies.copied') : label}
    </button>
  )
}

/** The recovery code, shown right after the first buddy (and on request). */
function RecoveryCode({ code, onDone }: { code: string; onDone: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="buddy-recovery" role="alert" data-testid="buddy-recovery">
      <strong>{t('buddies.recovery.title')}</strong>
      <p>{t('buddies.recovery.why')}</p>
      <code className="buddy-code-text" aria-label={t('buddies.recovery.label')}>{code}</code>
      <p className="muted">{t('buddies.recovery.where')}</p>
      <div className="copy-row">
        <CopyButton text={code} label={t('buddies.recovery.copy')} />
        <button type="button" className="button primary" onClick={onDone}>{t('buddies.recovery.saved')}</button>
      </div>
    </div>
  )
}

function BuddyRow({ server, buddy }: { server: ServerState; buddy: Buddy }) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = buddyState(buddy)
  const percent = buddy.uploading && buddy.uploading.total > 0 ? Math.round((buddy.uploading.done / buddy.uploading.total) * 100) : 0

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await removeBuddy(server.key, buddy.id)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <li className={`buddy-row ${state}`} data-testid="buddy-row">
      <div className="buddy-main">
        <strong className="buddy-name">{buddy.name}</strong>
        <span className="muted buddy-url">{buddy.url}</span>
        <span className={`buddy-state ${state}`} role="status">
          {state === 'sending' && t('buddies.state.sending', { percent })}
          {state === 'ok' && t('buddies.state.ok', { when: when(buddy.lastOk!.at), size: formatBytes(buddy.lastOk!.size) })}
          {state === 'waiting' && t('buddies.state.waiting')}
          {state === 'removed' && t('buddies.state.removed')}
          {state === 'problem' && (buddy.nextTryAt
            ? t('buddies.state.problemRetry', { reason: problemText(buddy.error!), when: when(buddy.nextTryAt) })
            : t('buddies.state.problem', { reason: problemText(buddy.error!) }))}
        </span>
        {state === 'sending' && <progress value={percent} max={100} aria-label={t('buddies.state.sending', { percent })} />}
        {state === 'ok' && buddy.error === null && (
          <span className="muted buddy-detail">{t('buddies.keeps', { count: buddy.keep, quota: quotaText(buddy.quotaBytes) })}</span>
        )}
        {error && <span className="error-text">{error}</span>}
      </div>
      <div className="buddy-actions">
        {confirming ? (
          <>
            <span className="muted">{t('buddies.removeConfirm')}</span>
            <button type="button" className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? <Spinner /> : t('buddies.remove')}</button>
            <button type="button" className="button ghost" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
          </>
        ) : (
          <button type="button" className="button ghost" onClick={() => setConfirming(true)}>{t('buddies.remove')}</button>
        )}
      </div>
    </li>
  )
}

/** Our backups at friends' servers. */
function Buddies({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const status = useBuddies((s) => s.status[server.key])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'add' | 'now' | 'code' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<string | null>(null)
  const address = pairingCodeAddress(code)

  useEffect(() => {
    loadBuddies(server.key).catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])

  async function run(what: 'add' | 'now' | 'code', action: () => Promise<void>) {
    setBusy(what)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (!status) return error ? <p className="error-text">{error}</p> : <Spinner />
  return (
    <div className="buddies" data-testid="buddies">
      {recovery && <RecoveryCode code={recovery} onDone={() => setRecovery(null)} />}
      {!status.autoEnabled && <p className="buddy-note">{t('buddies.needsDaily')}</p>}
      {status.buddies.length > 0 && (
        <ul className="buddy-list" aria-label={t('buddies.title')}>
          {status.buddies.map((b) => <BuddyRow key={b.id} server={server} buddy={b} />)}
        </ul>
      )}
      <form className="buddy-add" onSubmit={(e) => {
        e.preventDefault()
        if (!address || busy) return
        void run('add', async () => {
          const made = await addBuddy(server.key, code)
          setCode('')
          if (made) setRecovery(made)
        })
      }}>
        <label className="field">
          <span>{t('buddies.code')}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="iskra-buddy:…" maxLength={1024}
            spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy === 'add'} />
        </label>
        <p className="muted buddy-hint">
          {code.trim() && !address ? t('buddies.codeInvalid') : address ? t('buddies.codeLeadsTo', { address }) : t('buddies.codeHint')}
        </p>
        <div className="copy-row">
          <button type="submit" className="button primary" disabled={!address || busy !== null}>{busy === 'add' ? <Spinner /> : t('buddies.add')}</button>
          {status.buddies.length > 0 && (
            <button type="button" className="button" disabled={busy !== null || !status.autoEnabled} onClick={() => void run('now', () => backupNow(server.key))}>
              {busy === 'now' ? <Spinner /> : t('buddies.now')}
            </button>
          )}
          {status.recoveryCodeSet && !recovery && (
            <button type="button" className="button ghost" disabled={busy !== null} onClick={() => void run('code', async () => setRecovery(await showRecoveryCode(server.key)))}>
              {t('buddies.recovery.show')}
            </button>
          )}
        </div>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
}

function SpotRow({ server, spot }: { server: ServerState; spot: BuddySpot }) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove(now: boolean) {
    setBusy(true)
    setError(null)
    try {
      await removeSpot(server.key, spot.id, now)
      setConfirming(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`buddy-row ${spot.state}`} data-testid="spot-row">
      <div className="buddy-main">
        <strong className="buddy-name">{spot.label}</strong>
        {spot.sourceName && <span className="muted buddy-url">{t('buddies.spot.from', { name: spot.sourceName })}</span>}
        <span className={`buddy-state ${spot.state}`}>
          {spot.state === 'waiting' && t('buddies.spot.waiting', { when: when(spot.codeExpiresAt ?? 0) })}
          {spot.state === 'active' && (spot.lastUploadAt ? t('buddies.spot.active', { when: when(spot.lastUploadAt) }) : t('buddies.spot.noCopies'))}
          {spot.state === 'removing' && t('buddies.spot.removing', { when: when(spot.deleteAt ?? 0) })}
        </span>
        <div className="buddy-usage">
          <progress value={spotUsage(spot)} max={1} aria-label={t('buddies.spot.usage', { used: formatBytes(spot.used), quota: quotaText(spot.quotaBytes) })} />
          <span className="muted">
            {t('buddies.spot.usage', { used: formatBytes(spot.used), quota: quotaText(spot.quotaBytes) })}
            {' · '}{t('buddies.spot.copies', { count: spot.versions.length, keep: spot.keep })}
          </span>
        </div>
        {error && <span className="error-text">{error}</span>}
      </div>
      <div className="buddy-actions">
        {confirming ? (
          <>
            <span className="muted">{spot.state === 'active' && spot.graceDays > 0 ? t('buddies.spot.removeConfirm', { count: spot.graceDays }) : t('buddies.spot.removeNowConfirm')}</span>
            <button type="button" className="button danger" disabled={busy} onClick={() => void remove(spot.state !== 'active')}>{busy ? <Spinner /> : t('buddies.remove')}</button>
            <button type="button" className="button ghost" disabled={busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
          </>
        ) : (
          <button type="button" className="button ghost" onClick={() => setConfirming(true)}>{spot.state === 'removing' ? t('buddies.spot.deleteNow') : t('buddies.remove')}</button>
        )}
      </div>
    </li>
  )
}

const KEEP_CHOICES = [3, 5, 7, 14]
const GRACE_CHOICES = [0, 1, 7, 14, 30]

/** Spots on this server for friends' servers. */
function Spots({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const spots = useBuddies((s) => s.spots[server.key])
  const [label, setLabel] = useState('')
  const [quotaMb, setQuotaMb] = useState(2048)
  const [keep, setKeep] = useState(3)
  const [graceDays, setGraceDays] = useState(7)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<{ label: string; code: string } | null>(null)

  useEffect(() => {
    loadSpots(server.key).catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])

  async function create() {
    if (!label.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const code = await createSpot(server.key, { label: label.trim(), quotaMb, keep, graceDays, ...(url.trim() ? { url: url.trim() } : {}) })
      setMade({ label: label.trim(), code })
      setLabel('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!spots) return error ? <p className="error-text">{error}</p> : <Spinner />
  return (
    <div className="buddies" data-testid="spots">
      {spots.spots.length > 0 && (
        <ul className="buddy-list" aria-label={t('buddies.spot.title')}>
          {spots.spots.map((s) => <SpotRow key={s.id} server={server} spot={s} />)}
        </ul>
      )}
      {made ? (
        <div className="buddy-recovery" role="status" data-testid="spot-code">
          <strong>{t('buddies.spot.codeTitle', { label: made.label })}</strong>
          <p>{t('buddies.spot.codeHint')}</p>
          <code className="buddy-code-text pairing" aria-label={t('buddies.spot.codeLabel')}>{made.code}</code>
          <div className="copy-row">
            <CopyButton text={made.code} label={t('buddies.spot.copyCode')} />
            <button type="button" className="button ghost" onClick={() => setMade(null)}>{t('buddies.spot.done')}</button>
          </div>
        </div>
      ) : (
        <form className="buddy-spot-form" onSubmit={(e) => { e.preventDefault(); void create() }}>
          <label className="field">
            <span>{t('buddies.spot.label')}</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} placeholder={t('buddies.spot.labelPlaceholder')} disabled={busy} />
          </label>
          <div className="buddy-spot-options">
            <label className="field">
              <span>{t('buddies.spot.quota')}</span>
              <select value={quotaMb} onChange={(e) => setQuotaMb(Number(e.target.value))} disabled={busy}>
                {QUOTA_CHOICES_MB.map((mb) => <option key={mb} value={mb}>{quotaText(mb * 1024 * 1024)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>{t('buddies.spot.keep')}</span>
              <select value={keep} onChange={(e) => setKeep(Number(e.target.value))} disabled={busy}>
                {KEEP_CHOICES.map((n) => <option key={n} value={n}>{t('buddies.spot.keepCount', { count: n })}</option>)}
              </select>
            </label>
            <label className="field">
              <span>{t('buddies.spot.grace')}</span>
              <select value={graceDays} onChange={(e) => setGraceDays(Number(e.target.value))} disabled={busy}>
                {GRACE_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? t('buddies.spot.graceNone') : t('settings.invite.days', { count: n })}</option>)}
              </select>
            </label>
          </div>
          {spots.address
            ? <p className="muted buddy-hint">{t('buddies.spot.address', { address: spots.address })}</p>
            : (
              <label className="field">
                <span>{t('buddies.spot.addressField')}</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" maxLength={512} spellCheck={false}
                  autoCapitalize="off" autoCorrect="off" disabled={busy} />
              </label>
            )}
          <p className="muted buddy-hint">{t('buddies.spot.graceHint')}</p>
          <button type="submit" className="button primary" disabled={!label.trim() || busy || (!spots.address && !url.trim())}>
            {busy ? <Spinner /> : t('buddies.spot.create')}
          </button>
        </form>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
}

export function BuddySection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  return (
    <>
      <section className="settings-section backup" data-testid="buddy-section">
        <h2>{t('buddies.title')}</h2>
        <p className="muted">{t('buddies.intro')}</p>
        <Buddies server={server} />
      </section>
      <section className="settings-section backup" data-testid="hold-section">
        <h2>{t('buddies.spot.title')}</h2>
        <p className="muted">{t('buddies.spot.intro')}</p>
        <Spots server={server} />
      </section>
    </>
  )
}
