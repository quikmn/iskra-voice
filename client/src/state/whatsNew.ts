// "What's new": after the app updates (desktop, web app, phone apps), a card with the new version's highlights, once.
// Never on a fresh install: only when this device saw an earlier version. Remembered per device (localStorage).
import { create } from 'zustand'
import { RELEASE_VERSION } from '../links'
import type { WhatsNewNotes } from '../releaseNotes'
import { useApp } from './store'

declare const __ISKRA_WHATS_NEW__: WhatsNewNotes | null | undefined

/** The version this device last ran. */
export const SEEN_KEY = 'iskra.whats-new-seen'

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** Semver precedence (a < b → negative); something that isn't a version sorts below everything. */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a)
  const y = VERSION.exec(b)
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i])
  if (!x[4] || !y[4]) return (x[4] ? -1 : 0) - (y[4] ? -1 : 0) // a release beats its prereleases
  const p = x[4].split('.')
  const q = y[4].split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1
    const pn = /^\d+$/.test(p[i])
    const qn = /^\d+$/.test(q[i])
    if (pn && qn && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i])
    if (pn !== qn) return pn ? -1 : 1
    if (!pn && p[i] !== q[i]) return p[i] < q[i] ? -1 : 1
  }
  return 0
}

export interface WhatsNewInput {
  /** The version this device last ran (null: never recorded). */
  seen: string | null
  /** This build's version. */
  current: string
  /** This build's notes (null when the build has none, e.g. a development build). */
  notes: WhatsNewNotes | null
  /**
   * An account was already on this device when the app started. Before this card existed nothing recorded the
   * version, so that's how an update from such a version is told apart from a fresh install.
   */
  hadAccount: boolean
}

/** Whether to show the card, and the version to remember from now on (always this one). */
export function decideWhatsNew({ seen, current, notes, hadAccount }: WhatsNewInput): { show: WhatsNewNotes | null; remember: string } {
  const remember = current
  const usable = notes && notes.version === current && notes.en.length > 0 ? notes : null
  if (!usable) return { show: null, remember }
  if (seen === null) return { show: hadAccount ? usable : null, remember }
  return { show: compareVersions(current, seen) > 0 ? usable : null, remember }
}

/** The lines to show in a language: Swedish when the notes have them, else English (with the Swedish heading). */
export function linesFor(notes: WhatsNewNotes, language: string): string[] {
  return language.startsWith('sv') && notes.sv?.length ? notes.sv : notes.en
}

interface WhatsNewState {
  notes: WhatsNewNotes | null
}

export const useWhatsNew = create<WhatsNewState>(() => ({ notes: null }))

export function dismissWhatsNew(): void {
  useWhatsNew.setState({ notes: null })
}

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}

function writeSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version)
  } catch {
    /* private mode: it may show again next time */
  }
}

const buildNotes = (): WhatsNewNotes | null => (typeof __ISKRA_WHATS_NEW__ === 'object' ? __ISKRA_WHATS_NEW__ : null)

/**
 * Decides once, as soon as the app knows whether this device already had an account (the first phase after
 * "loading"), and remembers this version at once so the card shows only this one time.
 */
export function startWhatsNew(notes: WhatsNewNotes | null = buildNotes(), current = RELEASE_VERSION): () => void {
  let done = false
  const decide = (phase: string) => {
    if (done || phase === 'loading') return
    done = true
    const { show, remember } = decideWhatsNew({ seen: readSeen(), current, notes, hadAccount: phase !== 'onboarding' })
    if (readSeen() !== remember) writeSeen(remember)
    if (show) useWhatsNew.setState({ notes: show })
  }
  decide(useApp.getState().phase)
  if (done) return () => undefined
  const unsubscribe = useApp.subscribe((s) => {
    decide(s.phase)
    if (done) unsubscribe()
  })
  return unsubscribe
}
