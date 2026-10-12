// Desktop app updates, as the shell reports them (see desktop/src/updates.ts).
export type UpdateStatus =
  | { state: 'none' }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'available'; version: string; url: string }

export type UpdateNotice = { kind: 'ready'; version: string } | { kind: 'available'; version: string; url: string }

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,40})?$/
const RELEASES = 'https://github.com/quikmn/iskra-voice/releases/'

/** Only well-formed statuses, and only release links on GitHub. */
export function parseUpdateStatus(value: unknown): UpdateStatus {
  const v = value as Partial<{ state: string; version: string; url: string }> | null
  if (!v || typeof v.version !== 'string' || !VERSION.test(v.version)) return { state: 'none' }
  if (v.state === 'ready' || v.state === 'downloading') return { state: v.state, version: v.version }
  if (v.state === 'available' && typeof v.url === 'string' && v.url.startsWith(RELEASES)) return { state: 'available', version: v.version, url: v.url }
  return { state: 'none' }
}

/** What to show: "restart to update" once downloaded, or a download link when this build can't update itself. */
export function updateNotice(status: UpdateStatus, dismissed: string | null): UpdateNotice | null {
  if (status.state === 'ready' && dismissed !== status.version) return { kind: 'ready', version: status.version }
  if (status.state === 'available' && dismissed !== status.version) return { kind: 'available', version: status.version, url: status.url }
  return null
}

/** The version the shell is about to restart into ("Updating Iskra to X…"), or null. */
export const parseUpdatingVersion = (value: unknown): string | null => (typeof value === 'string' && VERSION.test(value) ? value : null)
