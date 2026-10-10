// Settings → Import from Discord (owner): upload a DiscordChatExporter export and watch it come in.
import { useEffect, useRef, useState } from 'react'
import type { ImportJob } from '../../core/protocol'
import { cancelImport, formatBytes, importFraction, loadImportStatus, startImport, useBackups } from '../../state/backups'
import { selectChannel, useApp, type ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './backup.css'

const EXPORTER = 'https://github.com/Tyrrrz/DiscordChatExporter'

function phaseText(job: ImportJob): string {
  switch (job.phase) {
    case 'reading': return job.current ? `Reading ${job.current}…` : 'Reading the export…'
    case 'importing':
      return `${job.messagesDone.toLocaleString()} of ${job.messages.toLocaleString()} messages · channel ${Math.min(job.channelsDone + 1, job.channels)} of ${job.channels}${job.current ? ` (#${job.current})` : ''}`
    case 'done': return 'Done'
    case 'failed': return job.error ?? "The import didn't work."
    case 'cancelled': return 'Cancelled. Nothing was kept.'
  }
}

function Result({ server, job }: { server: ServerState; job: ImportJob }) {
  const byCategory = new Map<string, ImportJob['imported']>()
  for (const channel of job.imported.filter((c) => !c.thread)) {
    const key = channel.category ?? ''
    byCategory.set(key, [...(byCategory.get(key) ?? []), channel])
  }
  const threads = job.imported.filter((c) => c.thread).length
  return (
    <div className="import-result">
      <p>
        <strong>{job.messagesDone.toLocaleString()} messages</strong> in {job.imported.length - threads} channels
        {threads > 0 && ` and ${threads} threads`}, with {job.files.toLocaleString()} files.
        {job.missingFiles > 0 && ` ${job.missingFiles.toLocaleString()} files weren't in the export; their names are shown instead.`}
      </p>
      {[...byCategory].map(([category, channels]) => (
        <div key={category} className="import-category">
          {category && <div className="import-category-name">{category}</div>}
          <ul>
            {channels.map((c) => (
              <li key={c.id}>
                <button className="link" onClick={() => {
                  useApp.setState({ activeServer: server.key })
                  selectChannel(server.key, c.id)
                }}>#{c.name}</button>
                <span className="muted">{c.messages.toLocaleString()} messages</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function ImportSection({ server }: { server: ServerState }) {
  const job = useBackups((s) => s.imports[server.key])
  const [file, setFile] = useState<File | null>(null)
  const [readOnly, setReadOnly] = useState(false)
  const [upload, setUpload] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const running = !!job && (job.phase === 'reading' || job.phase === 'importing')

  useEffect(() => {
    loadImportStatus(server.key).catch(() => undefined)
  }, [server.key])

  async function start() {
    if (!file) return
    setError(null)
    setUpload(0)
    try {
      await startImport(server.key, file, readOnly, setUpload)
      setFile(null)
      if (input.current) input.current.value = ''
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUpload(null)
    }
  }

  const fraction = job ? importFraction(job) : null
  return (
    <section className="settings-section import" data-testid="import-section">
      <h3>Import from Discord</h3>
      <p className="muted">
        Bring your Discord server's history along: channels, messages with their dates, replies, pins, files and reaction counts.
        Messages keep their authors' Discord names and pictures and are marked as imported.
      </p>
      <ol className="import-how">
        <li>
          Export your channels with <a href={EXPORTER} target="_blank" rel="noopener noreferrer">DiscordChatExporter</a> in the{' '}
          <strong>JSON</strong> format. Turn on <strong>Download assets</strong> to bring files and profile pictures too.
        </li>
        <li>Zip the folder it made (or pick a single .json file).</li>
        <li>Upload it here. You can keep using Iskra while it imports.</li>
      </ol>

      {!running && upload === null && (
        <div className="import-form">
          <label className="field">
            <span>Export</span>
            <input ref={input} type="file" accept=".zip,.json,application/zip,application/json"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null) }} />
          </label>
          {file && <p className="muted">{file.name} · {formatBytes(file.size)}</p>}
          <label className="checkbox">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            Keep imported channels as a read-only archive (only admins can post there)
          </label>
          <button className="button primary" disabled={!file} onClick={() => void start()}>Import</button>
        </div>
      )}

      {upload !== null && (
        <div className="backup-progress" aria-live="polite">
          <progress value={upload} max={1} aria-label="Uploading" />
          <span className="muted">Uploading… {Math.round(upload * 100)}%</span>
        </div>
      )}

      {job && (
        <div className={`import-status ${job.phase}`} aria-live="polite" data-testid="import-status">
          {running && (
            <div className="backup-progress">
              <progress value={fraction ?? undefined} max={1} aria-label="Importing" />
              <span className="muted">{phaseText(job)}</span>
            </div>
          )}
          {!running && job.phase !== 'done' && <p className={job.phase === 'failed' ? 'error-text' : 'muted'}>{phaseText(job)}</p>}
          {job.phase === 'done' && <Result server={server} job={job} />}
          {job.warnings.length > 0 && (
            <details className="import-warnings">
              <summary>{job.warnings.length} note{job.warnings.length === 1 ? '' : 's'}</summary>
              <ul>{job.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
          {running && (
            <button className="button danger-outline" onClick={() => void cancelImport(server.key).catch((e: Error) => setError(e.message))}>
              {job.phase === 'reading' ? <Spinner /> : null} Cancel import
            </button>
          )}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}

      <p className="muted import-note">
        Roles and permissions don't come along: DiscordChatExporter can't export them, so set up roles here and invite your friends.
        Direct messages aren't imported.
      </p>
    </section>
  )
}
