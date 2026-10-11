import { describe, expect, it } from 'vitest'
import type { ServerUpdateStatus } from '../core/protocol'
import { autoBlockText, normalizeWindow, progressPercent, stateText, updateNotice } from './serverUpdates'

const base: ServerUpdateStatus = {
  current: '2.0.0-alpha.10',
  mode: 'notify',
  channel: 'stable',
  window: '04:00',
  requireAttestation: false,
  managed: null,
  canCheck: true,
  auto: { possible: false, reason: 'platform' },
  latest: { version: '2.0.0-alpha.11', url: 'https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0-alpha.11', publishedAt: 1, prerelease: false, package: true },
  state: 'idle',
  progress: null,
  checkedAt: 1,
  error: null,
  lastUpdate: null,
  attested: null,
}

describe('server update notice', () => {
  it('shows a new version to the owner', () => {
    expect(updateNotice(base, null)).toEqual({ version: '2.0.0-alpha.11', url: base.latest!.url, installing: false })
  })

  it('stays away when there is nothing new, updates are off, or the app manages them', () => {
    expect(updateNotice(undefined, null)).toBeNull()
    expect(updateNotice({ ...base, latest: null }, null)).toBeNull()
    expect(updateNotice({ ...base, mode: 'off' }, null)).toBeNull()
    expect(updateNotice({ ...base, managed: 'desktop' }, null)).toBeNull()
  })

  it('remembers a dismissed version, but a newer one shows again', () => {
    expect(updateNotice(base, '2.0.0-alpha.11')).toBeNull()
    expect(updateNotice(base, '2.0.0-alpha.10')).not.toBeNull()
  })

  it('always shows an install that is running', () => {
    expect(updateNotice({ ...base, state: 'downloading' }, '2.0.0-alpha.11')).toMatchObject({ installing: true })
    expect(updateNotice({ ...base, state: 'failed' }, null)).toMatchObject({ installing: false })
  })
})

describe('server update texts', () => {
  it('explains every reason auto-install is off', () => {
    for (const reason of ['desktop', 'development', 'platform', 'guard', 'readonly'] as const) expect(autoBlockText(reason)).not.toBe('')
    expect(autoBlockText(null)).toBe('')
  })

  it('shows download progress', () => {
    expect(progressPercent({ ...base, progress: { done: 50, total: 200 } })).toBe(25)
    expect(progressPercent({ ...base, progress: { done: 5, total: 0 } })).toBeNull()
    expect(progressPercent({ ...base, progress: { done: 500, total: 200 } })).toBe(100)
    expect(stateText({ ...base, state: 'downloading', progress: { done: 1, total: 4 } })).toBe('Downloading… 25%')
    expect(stateText({ ...base, state: 'downloading' })).toBe('Downloading…')
    expect(stateText(base)).toBeNull()
  })

  it('reads times the way the server wants them', () => {
    expect(normalizeWindow('4:00')).toBe('04:00')
    expect(normalizeWindow(' 23:59 ')).toBe('23:59')
    expect(normalizeWindow('24:00')).toBeNull()
    expect(normalizeWindow('04:60')).toBeNull()
    expect(normalizeWindow('4am')).toBeNull()
  })
})
