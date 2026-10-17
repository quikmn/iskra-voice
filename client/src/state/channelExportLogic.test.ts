import { describe, expect, it } from 'vitest'
import type { Channel, ExportJob } from '../core/protocol'
import { dateRange, exportability, jobFraction, liveJobs, upsertJob } from './channelExportLogic'

const channel = (kind: Channel['kind'], e2ee: unknown = null) =>
  ({ id: 1, name: 'x', kind, position: 0, readRole: 'member', writeRole: 'member', e2ee }) as Channel & { e2ee: unknown }

const job = (id: string, createdAt: number, extra: Partial<ExportJob> = {}): ExportJob => ({
  id, state: 'running', channelIds: [1], from: null, to: null, attachments: true, threads: true, done: 0, total: 0, createdAt,
  url: null, name: null, size: null, expiresAt: null, error: null, ...extra,
})

describe('channel export', () => {
  it('exports text, voice, stage, forum and docs channels, never encrypted ones or whiteboards', () => {
    for (const kind of ['text', 'voice', 'stage', 'forum', 'docs'] as const) expect(exportability(channel(kind))).toBe('ok')
    expect(exportability(channel('whiteboard'))).toBe('kind')
    expect(exportability(channel('text', { version: 1 }))).toBe('encrypted')
    expect(exportability(channel('voice', { version: 1 }))).toBe('encrypted')
  })

  it('turns dates into a range from the start of the first day to the end of the last, in local time', () => {
    expect(dateRange('', '')).toEqual({})
    const range = dateRange('2026-10-01', '2026-10-02')!
    expect(range.from).toBe(new Date(2026, 9, 1).getTime())
    expect(range.to).toBe(new Date(2026, 9, 3).getTime() - 1)
    expect(dateRange('2026-10-01', '')).toEqual({ from: new Date(2026, 9, 1).getTime() })
    expect(dateRange('', '2026-10-01')).toEqual({ to: new Date(2026, 9, 2).getTime() - 1 })
    expect(dateRange('2026-10-01', '2026-10-01')).not.toBeNull()
    expect(dateRange('2026-10-02', '2026-10-01')).toBeNull()
    expect(dateRange('nonsense', '')).toEqual({})
  })

  it('keeps jobs newest first and replaces updates', () => {
    let jobs = upsertJob([], job('a', 1))
    jobs = upsertJob(jobs, job('b', 2))
    jobs = upsertJob(jobs, job('a', 1, { state: 'done', done: 4, total: 4 }))
    expect(jobs.map((j) => [j.id, j.state])).toEqual([['b', 'running'], ['a', 'done']])
  })

  it('measures progress and drops jobs whose link has gone', () => {
    expect(jobFraction(job('a', 1))).toBeNull()
    expect(jobFraction(job('a', 1, { done: 5, total: 20 }))).toBe(0.25)
    expect(jobFraction(job('a', 1, { done: 30, total: 20 }))).toBe(1)
    const jobs = [job('a', 3), job('b', 2, { state: 'done', expiresAt: 100 }), job('c', 1, { state: 'failed', expiresAt: 10 })]
    expect(liveJobs(jobs, 50).map((j) => j.id)).toEqual(['a', 'b'])
  })
})
