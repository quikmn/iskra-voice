// Settings → Import from Discord (owner): upload a DiscordChatExporter export and watch it come in.
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { t } from '../../i18n'
import { errorMessage } from '../../i18n/errors'
import { formatNumber } from '../../i18n/format'
import type { ImportJob } from '../../core/protocol'
import { cancelImport, formatBytes, importFraction, loadImportStatus, startImport, useBackups } from '../../state/backups'
import { selectChannel, useApp, type ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './backup.css'

const EXPORTER = 'https://github.com/Tyrrrz/DiscordChatExporter'

function phaseText(job: ImportJob): string {
  switch (job.phase) {
    case 'reading': return job.current ? t('settings.import.reading', { name: job.current }) : t('settings.import.readingExport')
    case 'importing':
      return t('settings.import.progress', {
        done: formatNumber(job.messagesDone), total: formatNumber(job.messages),
        channel: Math.min(job.channelsDone + 1, job.channels), channels: job.channels, current: job.current ? ` (#${job.current})` : '',
      })
    case 'done': return t('common.done')
    case 'failed': return job.error ?? t('settings.import.failed')
    case 'cancelled': return t('settings.import.cancelled')
  }
}

type Noun = 'messages' | 'channels' | 'threads' | 'files'
const count = (n: number, noun: Noun) => t(`settings.import.${noun}`, { count: n, n: formatNumber(n) })

function Result({ server, job }: { server: ServerState; job: ImportJob }) {
  useTranslation()
  const byCategory = new Map<string, ImportJob['imported']>()
  for (const channel of job.imported.filter((c) => !c.thread)) {
    const key = channel.category ?? ''
    byCategory.set(key, [...(byCategory.get(key) ?? []), channel])
  }
  const threads = job.imported.filter((c) => c.thread).length
  return (
    <div className="import-result">
      <p>
        <strong>{count(job.messagesDone, 'messages')}</strong> {t('settings.import.inChannels', { channels: count(job.imported.length - threads, 'channels') })}
        {threads > 0 && ` ${t('settings.import.andThreads', { threads: count(threads, 'threads') })}`}
        {job.files > 0 && `, ${t('settings.import.withFiles', { files: count(job.files, 'files') })}`}.
        {job.missingFiles === 1 && ` ${t('settings.import.missingOne')}`}
        {job.missingFiles > 1 && ` ${t('settings.import.missingMany', { files: count(job.missingFiles, 'files') })}`}
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
                <span className="muted">{count(c.messages, 'messages')}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function ImportSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
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
      setError(errorMessage(e))
    } finally {
      setUpload(null)
    }
  }

  const fraction = job ? importFraction(job) : null
  return (
    <section className="settings-section import" data-testid="import-section">
      <h2>{t('settings.sections.import')}</h2>
      <p className="muted">{t('settings.import.intro')}</p>
      <ol className="import-how">
        <li>
          <Trans i18nKey="settings.import.step1" components={{ a: <a href={EXPORTER} target="_blank" rel="noopener noreferrer" />, b: <strong /> }} />
        </li>
        <li>{t('settings.import.step2')}</li>
        <li>{t('settings.import.step3')}</li>
      </ol>

      {!running && upload === null && (
        <div className="import-form">
          <label className="field">
            <span>{t('settings.import.export')}</span>
            <input ref={input} type="file" accept=".zip,.json,application/zip,application/json"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null) }} />
          </label>
          {file && <p className="muted">{file.name} · {formatBytes(file.size)}</p>}
          <label className="checkbox">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            {t('settings.import.readOnly')}
          </label>
          <button className="button primary" disabled={!file} onClick={() => void start()}>{t('settings.import.import')}</button>
        </div>
      )}

      {upload !== null && (
        <div className="backup-progress" aria-live="polite">
          <progress value={upload} max={1} aria-label={t('settings.import.uploadingLabel')} />
          <span className="muted">{t('settings.import.uploading', { percent: Math.round(upload * 100) })}</span>
        </div>
      )}

      {job && (
        <div className={`import-status ${job.phase}`} aria-live="polite" data-testid="import-status">
          {running && (
            <div className="backup-progress">
              <progress value={fraction ?? undefined} max={1} aria-label={t('settings.import.importing')} />
              <span className="muted">{phaseText(job)}</span>
            </div>
          )}
          {!running && job.phase !== 'done' && <p className={job.phase === 'failed' ? 'error-text' : 'muted'}>{phaseText(job)}</p>}
          {job.phase === 'done' && <Result server={server} job={job} />}
          {job.warnings.length > 0 && (
            <details className="import-warnings">
              <summary>{t('settings.import.notes', { count: job.warnings.length })}</summary>
              <ul>{job.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
          {running && (
            <button className="button danger-outline" onClick={() => void cancelImport(server.key).catch((e: Error) => setError(errorMessage(e)))}>
              {job.phase === 'reading' ? <Spinner /> : null} {t('settings.import.cancel')}
            </button>
          )}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}

      <p className="muted import-note">{t('settings.import.note')}</p>
    </section>
  )
}
