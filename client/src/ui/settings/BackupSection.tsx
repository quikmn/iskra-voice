// Settings → Backup & move (owner): an encrypted backup to download, the daily copies on the server, and moving it.
import { useEffect, useState } from 'react'
import { createBackup, downloadFile, formatBytes, MIN_PASSPHRASE, passphraseStrength, useBackups } from '../../state/backups'
import { connectionFor, type ServerState } from '../../state/store'
import type { BackupStatus } from '../../core/protocol'
import { Spinner } from '../bits'
import { MoveServerDialog } from './MoveServerDialog'
import '../dialogs/InternetSettings.css'
import './backup.css'

const STRENGTH: Record<ReturnType<typeof passphraseStrength>, string> = {
  'too-short': `At least ${MIN_PASSPHRASE} characters.`,
  weak: 'Works, but a longer one is safer: a few random words are easy to remember.',
  ok: 'Good.',
  strong: 'Strong.',
}

/** Passphrase (twice), then "Make backup": builds it on the server and downloads it. */
export function BackupMaker({ server, onMade }: { server: ServerState; onMade?: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<{ url: string; name: string; size: number } | null>(null)
  const progress = useBackups((s) => s.progress[server.key])
  const strength = passphraseStrength(passphrase)
  const mismatch = again.length > 0 && again !== passphrase
  const ready = strength !== 'too-short' && again === passphrase && !busy

  async function make() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const result = await createBackup(server.key, passphrase)
      setMade(result)
      setPassphrase('')
      setAgain('')
      downloadFile(result.url)
      onMade?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (made) {
    return (
      <div className="backup-done" role="status">
        <span className="backup-check" aria-hidden>✓</span>
        <div>
          <strong>Backup ready: {made.name}</strong>
          <p className="muted">
            {formatBytes(made.size)}. Your download should have started. Keep the file and the passphrase in different places: without the
            passphrase nobody can open it, not even you.
          </p>
          <div className="copy-row">
            <button className="button" onClick={() => downloadFile(made.url)}>Download again</button>
            <button className="button ghost" onClick={() => setMade(null)}>Make another</button>
          </div>
        </div>
      </div>
    )
  }

  const fraction = progress && progress.total > 0 ? progress.done / progress.total : null
  return (
    <form className="backup-maker" onSubmit={(e) => { e.preventDefault(); void make() }}>
      <label className="field">
        <span>Passphrase</span>
        <input type="password" autoComplete="new-password" value={passphrase} maxLength={1024} disabled={busy}
          onChange={(e) => setPassphrase(e.target.value)} aria-describedby={`strength-${server.key}`} />
      </label>
      <p id={`strength-${server.key}`} className={`backup-strength ${strength}`}>{passphrase ? STRENGTH[strength] : 'The backup holds the server\'s secret key, so it is encrypted with this.'}</p>
      <label className="field">
        <span>Passphrase again</span>
        <input type="password" autoComplete="new-password" value={again} maxLength={1024} disabled={busy}
          onChange={(e) => setAgain(e.target.value)} aria-invalid={mismatch} />
      </label>
      {mismatch && <p className="error-text">The passphrases don't match.</p>}
      {busy && (
        <div className="backup-progress" aria-live="polite">
          <progress value={fraction ?? undefined} max={1} aria-label="Making the backup" />
          <span className="muted">
            {fraction === null ? 'Preparing…' : `Packing ${formatBytes(progress!.done)} of ${formatBytes(progress!.total)}…`}
          </span>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <button className="button primary" type="submit" disabled={!ready}>
        {busy ? <Spinner /> : 'Make backup'}
      </button>
    </form>
  )
}

function AutoBackups({ server }: { server: ServerState }) {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    connectionFor(server.key)?.request('backup.status', {}).then(setStatus).catch((e: Error) => setError(e.message))
  }, [server.key])

  async function change(patch: { enabled?: boolean; keep?: number; includeUploads?: boolean }) {
    setError(null)
    try {
      const next = await connectionFor(server.key)?.request('backup.settings', patch)
      if (next) setStatus(next)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!status) return error ? <p className="error-text">{error}</p> : <Spinner />
  return (
    <>
      <div className="internet-head">
        <div>
          <strong>Back up every day</strong>
          <p className="muted">
            A copy of the messages, settings and keys, kept in the server's own folder in case something goes wrong there. For a copy
            somewhere else, download one above.
          </p>
        </div>
        <button className={`switch ${status.auto.enabled ? 'on' : ''}`} role="switch" aria-checked={status.auto.enabled}
          aria-label="Back up every day" onClick={() => void change({ enabled: !status.auto.enabled })}>
          <span />
        </button>
      </div>
      {status.auto.enabled && (
        <div className="backup-options">
          <label className="field inline">
            <span>Keep</span>
            <select value={status.auto.keep} onChange={(e) => void change({ keep: Number(e.target.value) })}>
              {[...new Set([3, 7, 14, 30, status.auto.keep])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n} days</option>)}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={status.auto.includeUploads} onChange={(e) => void change({ includeUploads: e.target.checked })} />
            Include uploaded files (uses much more space)
          </label>
        </div>
      )}
      {status.local.length > 0 ? (
        <ul className="backup-list" aria-label="Daily backups">
          {status.local.map((b) => (
            <li key={b.name}><code>{b.name}</code><span className="muted">{formatBytes(b.size)}</span></li>
          ))}
        </ul>
      ) : (
        status.auto.enabled && <p className="muted">The first one is made a few minutes after the server starts.</p>
      )}
      <p className="muted backup-folder">In <code>{status.folder}</code></p>
      {error && <p className="error-text">{error}</p>}
    </>
  )
}

export function BackupSection({ server }: { server: ServerState }) {
  const [moving, setMoving] = useState(false)
  return (
    <>
      <section className="settings-section backup" data-testid="backup-section">
        <h3>Backup &amp; move</h3>
        <p className="muted">
          Download everything about this server in one encrypted file: messages, channels, members, files, settings and its key. You can
          restore it on any computer with Iskra.
        </p>
        <BackupMaker server={server} />
      </section>
      <section className="settings-section backup">
        <h3>Daily backups</h3>
        <AutoBackups server={server} />
      </section>
      <section className="settings-section backup">
        <h3>Move this server</h3>
        <p className="muted">
          New PC, or moving to a VPS? Restore a backup there, then send everyone over: their apps switch to the new address by
          themselves.
        </p>
        <button className="button" onClick={() => setMoving(true)}>Move this server…</button>
      </section>
      {moving && <MoveServerDialog server={server} onClose={() => setMoving(false)} />}
    </>
  )
}
