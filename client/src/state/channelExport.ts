// Channel export (admins): jobs the server runs in the background, with progress, and their download links.
import { create } from 'zustand'
import type { Events, ExportJob, ExportOptions } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { upsertJob } from './channelExportLogic'
import { currentLanguage, t } from '../i18n'

interface ChannelExportState {
  /** serverKey → your export jobs, newest first. */
  jobs: Record<string, ExportJob[] | undefined>
}

export const useChannelExports = create<ChannelExportState>(() => ({ jobs: {} }))

function put(serverKey: string, job: ExportJob) {
  useChannelExports.setState((s) => ({ jobs: { ...s.jobs, [serverKey]: upsertJob(s.jobs[serverKey] ?? [], job) } }))
}

onServerEvent((serverKey, type, body) => {
  if (type === 'channel.export.progress') put(serverKey, (body as Events['channel.export.progress']).job)
})

// A new connection: progress may have been missed, so ask again next time the section opens.
onWelcomeHook((serverKey) => {
  useChannelExports.setState((s) => ({ jobs: { ...s.jobs, [serverKey]: undefined } }))
})

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

export async function loadExports(serverKey: string): Promise<void> {
  const { jobs } = await connection(serverKey).request('channel.export.status', {})
  useChannelExports.setState((s) => ({ jobs: { ...s.jobs, [serverKey]: jobs } }))
}

/** Starts an export on the server; progress then arrives as channel.export.progress. */
export async function startExport(serverKey: string, options: Omit<ExportOptions, 'timeZone' | 'lang'>): Promise<ExportJob> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const lang = currentLanguage()
  const { job } = await connection(serverKey).request('channel.export', { ...options, ...(timeZone ? { timeZone } : {}), lang })
  put(serverKey, job)
  return job
}

export async function cancelExport(serverKey: string, id: string): Promise<void> {
  const { job } = await connection(serverKey).request('channel.export.cancel', { id })
  put(serverKey, job)
}

/** The job's download link, absolute (or null until it's done). */
export function exportUrl(serverKey: string, job: ExportJob): string | null {
  if (!job.url) return null
  return (useApp.getState().servers[serverKey]?.url ?? '') + job.url
}
