// Settings → Updates (owner): which version runs, whether a newer one is out, and how updates happen.
import { useEffect, useState } from 'react'
import type { ServerUpdateStatus, UpdateMode } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { formatDate } from '../../i18n/format'
import { autoBlockText, changeUpdateSettings, checkForUpdates, installUpdate, normalizeWindow, progressPercent, stateText, useServerUpdates } from '../../state/serverUpdates'
import { connectionFor, type ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './updates.css'

const MODES: { id: UpdateMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Never looks for new versions.' },
  { id: 'notify', label: 'Tell me', hint: 'Looks on GitHub every few hours and tells you here when a new version is out.' },
  { id: 'auto', label: 'Install automatically', hint: 'Also installs it in the hour you pick, when nobody is in voice. Everyone gets a short notice, the server restarts, and if the new version doesn’t start, the previous one comes back.' },
]

export function UpdatesSection({ server }: { server: ServerState }) {
  const status = useServerUpdates((s) => s.status[server.key])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)

  useEffect(() => {
    connectionFor(server.key)
      ?.request('update.status', {})
      .then(({ status }) => useServerUpdates.setState((s) => ({ status: { ...s.status, [server.key]: status } })))
      .catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])

  async function run(kind: 'check' | 'install', action: () => Promise<unknown>) {
    setBusy(kind)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function change(patch: Parameters<typeof changeUpdateSettings>[1]) {
    setError(null)
    try {
      await changeUpdateSettings(server.key, patch)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <section className="settings-section updates" data-testid="updates-section">
      <h3>Updates</h3>
      {!status ? (
        error ? <p className="error-text">{error}</p> : <Spinner />
      ) : (
        <>
          <VersionCard status={status} busy={busy} onCheck={() => void run('check', () => checkForUpdates(server.key))}
            onInstall={() => void run('install', () => installUpdate(server.key))} />
          {status.managed === 'desktop' ? (
            <p className="muted">This server runs in the Iskra desktop app, so it updates together with the app. Nothing to set up here.</p>
          ) : status.canCheck ? (
            <UpdateSettings status={status} onChange={(patch) => void change(patch)} />
          ) : (
            <p className="muted">{autoBlockText(status.auto.reason)}</p>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
        </>
      )}
    </section>
  )
}

function VersionCard({ status, busy, onCheck, onInstall }: { status: ServerUpdateStatus; busy: 'check' | 'install' | null; onCheck: () => void; onInstall: () => void }) {
  const running = stateText(status)
  const percent = progressPercent(status)
  const working = !['idle', 'failed', 'checking'].includes(status.state)
  return (
    <div className={`update-card ${status.latest ? 'has-update' : ''}`}>
      <div className="update-card-row">
        <div className="update-card-text">
          <span className="muted">This server runs</span>
          <strong className="update-version">Iskra {status.current}</strong>
        </div>
        {status.canCheck && (
          <button className="button small" onClick={onCheck} disabled={busy !== null || working || status.state === 'checking'}>
            {status.state === 'checking' || busy === 'check' ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>

      {status.latest ? (
        <div className="update-available" role="status">
          <span className="update-dot" aria-hidden />
          <div className="update-card-text">
            <strong>Update available: {status.latest.version}</strong>
            <a href={status.latest.url} target="_blank" rel="noreferrer">What’s new</a>
          </div>
          {status.auto.possible && status.latest.package && (
            <button className="button primary small" onClick={onInstall} disabled={busy !== null || working}>
              {working ? 'Updating…' : 'Update now'}
            </button>
          )}
        </div>
      ) : status.canCheck && status.checkedAt ? (
        <p className="muted update-line">Up to date. Last checked {formatDate(status.checkedAt, { dateStyle: 'medium', timeStyle: 'short' })}.</p>
      ) : null}

      {status.latest && !status.auto.possible && status.canCheck && (
        <p className="muted update-line">Download the <code>iskra-server</code> package for your system from the release page, replace the files and start it again. Your server folder stays as it is.</p>
      )}
      {status.latest && !status.latest.package && status.auto.possible && (
        <p className="muted update-line">There’s no server package for this system in that release yet.</p>
      )}

      {running && (
        <div className="update-progress" role="status" aria-live="polite">
          <span>{running}</span>
          {status.state === 'downloading' && <progress max={100} value={percent ?? undefined} />}
        </div>
      )}
      {status.state === 'failed' && status.error && <p className="error-text update-line">The update didn’t go through: {status.error}</p>}
      {status.state !== 'failed' && status.error && <p className="muted update-line">{status.error}</p>}
      {status.lastUpdate && (
        <p className={`update-line ${status.lastUpdate.ok ? 'muted' : 'error-text'}`}>
          {status.lastUpdate.ok
            ? `Updated from ${status.lastUpdate.from} to ${status.lastUpdate.to}.`
            : `The update to ${status.lastUpdate.to} didn’t start, so ${status.lastUpdate.from} was put back. It won’t be tried again automatically.`}
        </p>
      )}
    </div>
  )
}

function UpdateSettings({ status, onChange }: { status: ServerUpdateStatus; onChange: (patch: Parameters<typeof changeUpdateSettings>[1]) => void }) {
  const [windowText, setWindowText] = useState(status.window)
  const [windowError, setWindowError] = useState(false)
  useEffect(() => setWindowText(status.window), [status.window])
  const mode = MODES.find((m) => m.id === status.mode) ?? MODES[1]

  function saveWindow() {
    const normalized = normalizeWindow(windowText)
    setWindowError(!normalized)
    if (normalized && normalized !== status.window) onChange({ window: normalized })
  }

  return (
    <div className="update-settings">
      <h4>When a new version is out</h4>
      <div className="segmented" role="radiogroup" aria-label="When a new version is out">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={status.mode === m.id} className={status.mode === m.id ? 'on' : ''}
            disabled={m.id === 'auto' && !status.auto.possible && status.mode !== 'auto'}
            onClick={() => status.mode !== m.id && onChange({ mode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="muted">{mode.hint}</p>
      {!status.auto.possible && <p className="muted update-why">{autoBlockText(status.auto.reason)}</p>}

      {status.mode === 'auto' && (
        <label className="field inline update-window">
          <span>Install between</span>
          <input type="time" value={windowText} aria-label="Install between" aria-invalid={windowError}
            onChange={(e) => setWindowText(e.target.value)} onBlur={saveWindow} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <span className="muted">and an hour later (server time)</span>
        </label>
      )}
      {windowError && <p className="error-text">Pick a time like 04:00.</p>}

      {status.mode !== 'off' && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={status.channel === 'prerelease'} onChange={(e) => onChange({ channel: e.target.checked ? 'prerelease' : 'stable' })} />
            Include test versions (prereleases)
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={status.requireAttestation} onChange={(e) => onChange({ requireAttestation: e.target.checked })} />
            Only install releases with a GitHub build attestation
          </label>
        </>
      )}
      <p className="muted update-note">
        Every download is checked against the release’s SHA256SUMS.txt and GitHub’s own checksum before anything is replaced.
      </p>
    </div>
  )
}
