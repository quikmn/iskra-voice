// "Share to Iskra" (state/shareIn.ts): checking what another app shared, and ordering where it can go. No React, no store.

/** One shared file, as the phone app copied it (a URL the page can fetch, on the app's own origin). */
export interface SharedFile {
  name: string
  type: string
  size: number
  url: string
}

export interface IncomingShare {
  id: string
  text: string
  files: SharedFile[]
  /** Files the app couldn't take (too many, too big, unreadable). */
  skipped: number
}

/** A message's limits (PROTOCOL.md, chat.send / DM content). */
export const MAX_SHARE_FILES = 10
export const MAX_SHARE_TEXT = 4000
const MAX_NAME = 120

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s)

/**
 * The message text for a share. Browsers share a link with the page title as the subject: "Title\nhttps://…" reads
 * better than the bare link. Other subjects (an email's) are left out.
 */
export function shareText(text: string | undefined, subject: string | undefined): string {
  const body = (text ?? '').trim()
  const title = (subject ?? '').trim().replace(/\s+/g, ' ')
  const out = title && isUrl(body) && !body.includes(title) ? `${title}\n${body}` : body
  return out.slice(0, MAX_SHARE_TEXT)
}

/** A plain file name: no folders or control characters, not too long. */
export function cleanShareName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:]+/g, '_').replace(/^[.\s]+|\s+$/g, '').slice(-MAX_NAME)
  return cleaned || 'file'
}

/**
 * A URL the page may fetch a shared file from: on the page's own origin. The iPhone app's page is on
 * capacitor://localhost, a scheme URL() gives no origin to ("null"), so there only the app's own file server counts
 * (capacitor://localhost/_capacitor_file_/…, the App Group copies) and only when the page itself is on that origin.
 */
export function isOwnFile(url: string, origin: string): boolean {
  try {
    const u = new URL(url, origin)
    if (u.origin !== 'null') return u.origin === origin
    return /^capacitor:\/\/[^/]+$/.test(origin) && `${u.protocol}//${u.host}` === origin && !u.username && !u.password &&
      u.pathname.startsWith('/_capacitor_file_/')
  } catch {
    return false
  }
}

/**
 * Checks a share from the native side (or a test). Files must be on the page's own origin (the app's copies), so a
 * share can never make the page fetch something elsewhere. Null when there's nothing to share.
 */
export function parseShare(raw: unknown, origin: string): IncomingShare | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const files: SharedFile[] = []
  let skipped = typeof r.skipped === 'number' && Number.isFinite(r.skipped) ? Math.max(0, Math.floor(r.skipped)) : 0
  for (const f of Array.isArray(r.files) ? r.files : []) {
    const file = f as Record<string, unknown> | null
    const url = str(file?.url)
    const size = file?.size
    if (!file || !url || !isOwnFile(url, origin) || typeof size !== 'number' || !Number.isFinite(size) || size < 0 || files.length >= MAX_SHARE_FILES) {
      skipped++
      continue
    }
    const type = str(file.type)
    files.push({
      name: cleanShareName(str(file.name) ?? ''),
      type: type && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.slice(0, 100) : 'application/octet-stream',
      size,
      url,
    })
  }
  const text = shareText(str(r.text), str(r.subject))
  if (!text && files.length === 0) return null
  const id = str(r.id)?.slice(0, 64) || String(Date.now())
  return { id, text, files, skipped }
}

// ── Destinations ──────────────────────────────────────────────────────────

export type ShareTarget =
  | { kind: 'channel'; id: string; serverKey: string; channelId: number; name: string; serverName: string; encrypted: boolean; activity: number }
  | { kind: 'dm'; id: string; peer: string; name: string; activity: number }
  | { kind: 'group'; id: string; key: string; name: string; serverName: string; activity: number }

export const channelTargetId = (serverKey: string, channelId: number) => `c:${serverKey}:${channelId}`
export const dmTargetId = (peer: string) => `d:${peer}`
export const groupTargetId = (key: string) => `g:${key}`

/** Folds case and accents, so "cafe" finds "Café". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

export function matchesQuery(target: ShareTarget, query: string): boolean {
  const q = fold(query.trim().replace(/^[#@]/, ''))
  if (!q) return true
  return fold(target.name).includes(q) || ('serverName' in target && fold(target.serverName).includes(q))
}

/**
 * The picker's list: places you shared to before (newest first), then the rest by recent activity (DMs and groups
 * before channels when equally quiet), filtered by the search. `people` (anyone else you could DM) only show when
 * searching, so the list isn't every member of every server.
 */
export function orderTargets(targets: ShareTarget[], people: ShareTarget[], recents: string[], query: string): { recent: ShareTarget[]; rest: ShareTarget[] } {
  const known = new Set(targets.map((t) => t.id))
  const all = query.trim() ? [...targets, ...people.filter((p) => !known.has(p.id))] : targets
  const shown = all.filter((t) => matchesQuery(t, query))
  const byId = new Map(shown.map((t) => [t.id, t]))
  const recent = recents.map((id) => byId.get(id)).filter((t): t is ShareTarget => !!t)
  const inRecent = new Set(recent.map((t) => t.id))
  const kindRank = (t: ShareTarget) => (t.kind === 'channel' ? 1 : 0)
  const rest = shown
    .filter((t) => !inRecent.has(t.id))
    .sort((a, b) => b.activity - a.activity || kindRank(a) - kindRank(b) || a.name.localeCompare(b.name))
  return { recent, rest }
}

/** The recents list after sharing to `id`: it moves to the front; at most `max` kept. */
export function rememberTarget(recents: string[], id: string, max = 8): string[] {
  return [id, ...recents.filter((x) => x !== id)].slice(0, max)
}

/** Files over a server's upload limit (MB; 0 or less: unknown, nothing flagged). */
export function overLimit(files: SharedFile[], maxUploadMb: number): SharedFile[] {
  if (!(maxUploadMb > 0)) return []
  return files.filter((f) => f.size > maxUploadMb * 1024 * 1024)
}
