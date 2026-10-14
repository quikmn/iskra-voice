import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WhatsNewNotes } from '../releaseNotes'
import { useApp } from './store'
import { compareVersions, decideWhatsNew, dismissWhatsNew, linesFor, SEEN_KEY, startWhatsNew, useWhatsNew } from './whatsNew'

const local = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v),
  removeItem: (k: string) => void local.delete(k), clear: () => local.clear(), key: () => null, get length() { return local.size },
})

const V = '2.0.0-alpha.17'
const NOTES: WhatsNewNotes = { version: V, en: ['Report a bug from inside the app.', 'AFK channel.'] }

describe("What's new: when to show it", () => {
  it('shows once after an update from an earlier version', () => {
    expect(decideWhatsNew({ seen: '2.0.0-alpha.16', current: V, notes: NOTES, hadAccount: true })).toEqual({ show: NOTES, remember: V })
    expect(decideWhatsNew({ seen: '2.0.0-alpha.9', current: V, notes: NOTES, hadAccount: true }).show).toBe(NOTES)
    // Once remembered, never again for this version.
    expect(decideWhatsNew({ seen: V, current: V, notes: NOTES, hadAccount: true })).toEqual({ show: null, remember: V })
  })

  it('never on a fresh install', () => {
    expect(decideWhatsNew({ seen: null, current: V, notes: NOTES, hadAccount: false })).toEqual({ show: null, remember: V })
  })

  it('shows for an account from before the card existed (nothing recorded yet)', () => {
    expect(decideWhatsNew({ seen: null, current: V, notes: NOTES, hadAccount: true }).show).toBe(NOTES)
  })

  it('not after going back to an older version, nor without notes for this one', () => {
    expect(decideWhatsNew({ seen: '2.0.0-alpha.18', current: V, notes: NOTES, hadAccount: true })).toEqual({ show: null, remember: V })
    expect(decideWhatsNew({ seen: '2.0.0-alpha.16', current: V, notes: null, hadAccount: true })).toEqual({ show: null, remember: V })
    expect(decideWhatsNew({ seen: '2.0.0-alpha.16', current: V, notes: { ...NOTES, version: '2.0.0-alpha.16' }, hadAccount: true }).show).toBeNull()
    expect(decideWhatsNew({ seen: 'garbage', current: V, notes: NOTES, hadAccount: true }).show).toBe(NOTES)
  })

  it('orders versions like semver', () => {
    expect(compareVersions('2.0.0-alpha.10', '2.0.0-alpha.9')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '2.0.0-alpha.20')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0-beta.1', '2.0.0-alpha.20')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0-alpha.16', '2.0.0-alpha.16')).toBe(0)
  })

  it('uses Swedish lines only when the notes have them', () => {
    expect(linesFor(NOTES, 'sv')).toEqual(NOTES.en)
    expect(linesFor({ ...NOTES, sv: ['AFK-kanal.'] }, 'sv')).toEqual(['AFK-kanal.'])
    expect(linesFor({ ...NOTES, sv: ['AFK-kanal.'] }, 'en')).toEqual(NOTES.en)
  })
})

describe("What's new: on start", () => {
  beforeEach(() => {
    local.clear()
    useApp.setState({ phase: 'loading' })
    dismissWhatsNew()
  })

  it('decides when the app knows whether there was an account, and remembers the version at once', () => {
    local.set(SEEN_KEY, '2.0.0-alpha.16')
    const stop = startWhatsNew(NOTES, V)
    expect(useWhatsNew.getState().notes).toBeNull() // still loading
    useApp.setState({ phase: 'ready' })
    expect(useWhatsNew.getState().notes).toBe(NOTES)
    expect(local.get(SEEN_KEY)).toBe(V)
    stop()

    // The next start (or a reload) shows nothing.
    dismissWhatsNew()
    useApp.setState({ phase: 'loading' })
    const again = startWhatsNew(NOTES, V)
    useApp.setState({ phase: 'ready' })
    expect(useWhatsNew.getState().notes).toBeNull()
    again()
  })

  it('a first run (onboarding) only records the version', () => {
    const stop = startWhatsNew(NOTES, V)
    useApp.setState({ phase: 'onboarding' })
    useApp.setState({ phase: 'ready' }) // signed up: still nothing to show
    expect(useWhatsNew.getState().notes).toBeNull()
    expect(local.get(SEEN_KEY)).toBe(V)
    stop()
  })

  it('a locked vault means an existing account', () => {
    local.set(SEEN_KEY, '2.0.0-alpha.16')
    const stop = startWhatsNew(NOTES, V)
    useApp.setState({ phase: 'locked' })
    expect(useWhatsNew.getState().notes).toBe(NOTES)
    stop()
  })
})
