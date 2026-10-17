// Channel export (PROTOCOL.md "Channel export"): which channels can go, the date range, and the job list. No React.
import type { Channel, ExportJob } from '../core/protocol'

/** Kinds the server exports (whiteboards can't be). */
export const EXPORTABLE_KINDS: readonly Channel['kind'][] = ['text', 'voice', 'stage', 'forum', 'docs']

/** Whether a channel can be exported from the server: encrypted ones only from a member's device. */
export function exportability(channel: Channel & { e2ee?: unknown }): 'ok' | 'encrypted' | 'kind' {
  if (channel.e2ee) return 'encrypted'
  return EXPORTABLE_KINDS.includes(channel.kind) ? 'ok' : 'kind'
}

/**
 * Dates from date inputs ("2026-10-01", or empty) as the export's range, in the viewer's own time zone: from the
 * start of the first day to the end of the last. Null when the start is after the end.
 */
export function dateRange(from: string, to: string): { from?: number; to?: number } | null {
  const parse = (text: string, end: boolean): number | undefined => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
    if (!m) return undefined
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return end ? new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() - 1 : day.getTime()
  }
  const range = { from: parse(from, false), to: parse(to, true) }
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) return null
  return Object.fromEntries(Object.entries(range).filter(([, v]) => v !== undefined))
}

/** Adds or replaces a job, newest first. */
export function upsertJob(jobs: readonly ExportJob[], job: ExportJob): ExportJob[] {
  return [job, ...jobs.filter((j) => j.id !== job.id)].sort((a, b) => b.createdAt - a.createdAt)
}

/** 0–1 while a job runs, or null before there's anything to count. */
export function jobFraction(job: ExportJob): number | null {
  return job.total > 0 ? Math.min(1, job.done / job.total) : null
}

/** Drops finished jobs whose link has gone. */
export function liveJobs(jobs: readonly ExportJob[], now: number): ExportJob[] {
  return jobs.filter((j) => j.state === 'running' || j.expiresAt === null || j.expiresAt > now)
}
