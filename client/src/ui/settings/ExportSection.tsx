// Server settings → Export channels (admins, or the "Export channels" permission): pick channels, a date range and what
// to include; the server builds a zip of readable pages, JSON and files in the background and hands out a link.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, ExportJob } from '../../core/protocol'
import { errorMessage, translatedServerMessage } from '../../i18n/errors'
import { formatDate } from '../../i18n/format'
import { downloadFile, formatBytes } from '../../state/backups'
import { cancelExport, exportUrl, loadExports, startExport, useChannelExports } from '../../state/channelExport'
import { dateRange, exportability, jobFraction, liveJobs } from '../../state/channelExportLogic'
import type { ServerState } from '../../state/store'
import { ChannelKindIcon } from '../ChannelKindIcon'
import { Spinner } from '../bits'
import './backup.css'
import './export.css'

export function ExportSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const channels = server.channels as (Channel & { e2ee?: unknown })[]
  const exportable = useMemo(() => channels.filter((c) => exportability(c) === 'ok').map((c) => c.id), [channels])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [attachments, setAttachments] = useState(true)
  const [threads, setThreads] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const jobs = useChannelExports((s) => s.jobs[server.key])
  const range = dateRange(from, to)
  const chosen = exportable.filter((id) => picked.has(id))

  useEffect(() => {
    if (jobs === undefined) loadExports(server.key).catch((e: unknown) => setError(errorMessage(e)))
  }, [jobs, server.key])

  function toggle(id: number, on: boolean) {
    setPicked((p) => {
      const next = new Set(p)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function start() {
    if (!range) return setError(t('channelExport.badRange'))
    if (chosen.length === 0) return setError(t('channelExport.pickOne'))
    setBusy(true)
    setError(null)
    try {
      await startExport(server.key, { channelIds: chosen, ...range, attachments, threads })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const running = jobs?.some((j) => j.state === 'running') ?? false
  const shown = liveJobs(jobs ?? [], Date.now())
  return (
    <section className="settings-section export-section" data-testid="export-section">
      <h2>{t('settings.sections.export')}</h2>
      <p className="muted">{t('channelExport.intro')}</p>

      <form className="export-form" onSubmit={(e) => { e.preventDefault(); void start() }}>
        <fieldset className="export-channels">
          <legend>{t('channelExport.channels')}</legend>
          {exportable.length > 0 && (
            <div className="export-pick-all">
              <button type="button" className="button small ghost" onClick={() => setPicked(new Set(exportable))}>{t('channelExport.selectAll')}</button>
              <button type="button" className="button small ghost" onClick={() => setPicked(new Set())}>{t('channelExport.selectNone')}</button>
            </div>
          )}
          {channels.length === 0 && <p className="muted">{t('channelExport.noChannels')}</p>}
          <ul>
            {channels.map((c) => {
              const why = exportability(c)
              return (
                <li key={c.id} className={why === 'ok' ? '' : 'disabled'}>
                  <label className="checkbox">
                    <input type="checkbox" disabled={why !== 'ok' || busy} checked={why === 'ok' && picked.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                    <ChannelKindIcon kind={c.kind} size={14} />
                    <span className="export-channel-name">{c.name}</span>
                    {why !== 'ok' && <span className="muted export-why">{t(why === 'encrypted' ? 'channelExport.encrypted' : 'channelExport.notExportable')}</span>}
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>

        <div className="export-range">
          <label className="field">
            <span>{t('channelExport.from')}</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span>{t('channelExport.to')}</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} disabled={busy} />
          </label>
        </div>
        <p className={range ? 'muted export-hint' : 'error-text'}>{range ? t('channelExport.rangeHint') : t('channelExport.badRange')}</p>
        <label className="checkbox">
          <input type="checkbox" checked={attachments} onChange={(e) => setAttachments(e.target.checked)} disabled={busy} />
          {t('channelExport.attachments')}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={threads} onChange={(e) => setThreads(e.target.checked)} disabled={busy} />
          {t('channelExport.threads')}
        </label>
        <p className="muted export-hint">{t('channelExport.privacy')}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="button primary" type="submit" disabled={busy || running || chosen.length === 0 || !range}>
          {busy ? <Spinner /> : t('channelExport.start', { count: Math.max(chosen.length, 1) })}
        </button>
      </form>

      {shown.length > 0 && (
        <>
          <h3>{t('channelExport.recent')}</h3>
          <ul className="export-jobs">
            {shown.map((job) => <JobRow key={job.id} server={server} job={job} />)}
          </ul>
        </>
      )}
    </section>
  )
}

function JobRow({ server, job }: { server: ServerState; job: ExportJob }) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const names = job.channelIds.map((id) => server.channels.find((c) => c.id === id)?.name).filter(Boolean).map((n) => `#${n}`)
  const fraction = jobFraction(job)
  const url = exportUrl(server.key, job)
  const failure = job.error
    ? (job.error.key && translatedServerMessage(job.error.key, job.error.args ?? {})) || job.error.message
    : null
  return (
    <li className={`export-job ${job.state}`} data-testid="export-job">
      <div className="export-job-head">
        <strong className="export-job-names">{names.length ? names.join(', ') : t('channelExport.channelCount', { count: job.channelIds.length })}</strong>
        <span className="muted">{formatDate(job.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      {job.state === 'running' && (
        <div className="backup-progress" aria-live="polite">
          <progress value={fraction ?? undefined} max={1} aria-label={t('channelExport.running')} />
          <span className="muted">{fraction === null ? t('channelExport.preparing') : t('channelExport.progress', { done: job.done, total: job.total })}</span>
          <button type="button" className="button small ghost" onClick={() => cancelExport(server.key, job.id).catch((e: unknown) => setError(errorMessage(e)))}>
            {t('channelExport.cancel')}
          </button>
        </div>
      )}
      {job.state === 'done' && url && (
        <div className="export-job-done">
          <span>{t('channelExport.done', { size: formatBytes(job.size ?? 0) })}</span>
          {job.expiresAt && <span className="muted">{t('channelExport.until', { time: formatDate(job.expiresAt, { timeStyle: 'short' }) })}</span>}
          <button type="button" className="button primary small" onClick={() => downloadFile(url)}>{t('channelExport.download')}</button>
        </div>
      )}
      {job.state === 'failed' && <p className="error-text" role="alert">{t('channelExport.failed')} {failure}</p>}
      {job.state === 'cancelled' && <p className="muted">{t('channelExport.cancelled')}</p>}
      {error && <p className="error-text">{error}</p>}
    </li>
  )
}
