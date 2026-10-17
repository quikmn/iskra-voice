// Pure rules for streamer mode (unit-tested; no React or sockets here): what counts as on, the synced setting's shape,
// and the masking of things that shouldn't be on a stream.

/** The synced part of streamer mode: the switch in My settings (newest copy wins across devices). */
export interface StreamerPref {
  on: boolean
  updatedAt: number
}

export const emptyStreamerPref = (): StreamerPref => ({ on: false, updatedAt: 0 })

/** A saved or synced copy, or null when it isn't one. */
export function parseStreamerPref(raw: unknown): StreamerPref | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.on !== 'boolean' || typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt) || r.updatedAt < 0) return null
  return { on: r.on, updatedAt: r.updatedAt }
}

/** Streamer mode is on while you switched it on, or while the desktop app sees one of your streaming programs running. */
export const streamerActive = (on: boolean, autoOn: boolean) => on || autoOn

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** Email addresses in free text become "•••@•••" (profiles and bios while streaming). */
export const maskEmails = (text: string) => text.replace(EMAIL, '•••@•••')

/** An invite link, code or account id as shown while streaming: the same length of dots, so layouts don't jump. */
export const maskSecret = (value: string) => '•'.repeat(Math.min(Math.max(value.length, 8), 24))
