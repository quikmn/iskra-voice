// "Download my data" (from a server, and from this device), the owner's security log and retention settings.
import type { Retention, SecurityEvent } from '../core/protocol'
import * as storage from '../core/storage'
import { b64u } from '../core/crypto'
import { connectionFor, useApp } from './store'
import { t } from '../i18n'
import type { en } from '../i18n/en'

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

/** Asks the server for everything it keeps about you (or, for the owner, about `accountKey`); returns an absolute download URL. */
export async function requestDataExport(serverKey: string, accountKey?: string): Promise<{ url: string; name: string; size: number }> {
  const result = await connection(serverKey).request('data.export', accountKey ? { accountKey } : {}, 5 * 60_000)
  const base = useApp.getState().servers[serverKey]?.url ?? ''
  return { url: base + result.url, name: result.name, size: result.size }
}

export const SECURITY_PAGE = 100
/** An export stops after this many entries (the newest). */
export const MAX_EXPORTED_EVENTS = 20_000

export function loadSecurityLog(serverKey: string, filter: { event?: string; before?: number }) {
  return connection(serverKey).request('security.log.list', { ...filter, limit: SECURITY_PAGE })
}

/** Every entry (newest first, up to MAX_EXPORTED_EVENTS), paging through the log. The server notes the export. */
export async function fetchWholeSecurityLog(serverKey: string): Promise<SecurityEvent[]> {
  const all: SecurityEvent[] = []
  let before: number | undefined
  for (;;) {
    const page = await connection(serverKey).request('security.log.list', { before, limit: 500, export: before === undefined })
    all.push(...page.entries)
    if (!page.hasMore || page.entries.length === 0 || all.length >= MAX_EXPORTED_EVENTS) break
    before = page.entries[page.entries.length - 1].id
  }
  return all.slice(0, MAX_EXPORTED_EVENTS)
}

export const getRetention = (serverKey: string) => connection(serverKey).request('retention.get', {})
export const updateRetention = (serverKey: string, change: Partial<Retention>) => connection(serverKey).request('retention.update', change)

/** The security log's event names the app has words for (others show as they are). */
export const SECURITY_EVENTS = [
  'auth.failed', 'rate_limited', 'member.joined', 'device.new', 'device.revoke', 'account.rotate', 'account.rotate.disputed',
  'account.delete', 'backup.download', 'backup.settings', 'backup.cli', 'backup.restored', 'server.move', 'server.move.cancel',
  'retention.update', 'data.export', 'security.log.export',
  'update.check', 'update.settings', 'update.install', 'update.installed', 'update.failed', 'update.rolledback',
  'captions.model.download', 'captions.model.rejected', 'translate.model.download', 'translate.model.rejected', 'translate.settings',
  'server.template', 'server.template.merge', 'server.autostart.install', 'server.autostart.remove',
  'account.dispute.resolve', 'keylog.alert', 'keylog.reloaded', 'keylog.broken', 'owner.claim.created',
  'join.pending', 'join.approved', 'join.declined', 'invites.paused', 'invites.resumed',
  'activity.added', 'activity.removed', 'activity.rejected',
] as const

export function securityEventLabel(event: string): string {
  if (!(SECURITY_EVENTS as readonly string[]).includes(event)) return event
  return t(`compliance.events.${event.replace(/\./g, '_') as keyof typeof en.compliance.events}`)
}

export const DAY_FIELDS = ['messagesDays', 'uploadsDays', 'auditDays', 'securityLogDays'] as const
export type DayField = typeof DAY_FIELDS[number]

/** True when a change deletes more than before: a shorter time, or a time where there was none. */
export function deletesMore(before: Retention, after: Partial<Retention>): boolean {
  return DAY_FIELDS.some((f) => {
    const next = after[f]
    return next !== undefined && next > 0 && (before[f] === 0 || next < before[f])
  })
}

/** Days for a field: a whole number from 0 to 36500, or null when it isn't one. */
export function parseDays(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,5}$/.test(trimmed)) return null
  const days = Number(trimmed)
  return days <= 36500 ? days : null
}

// ── Data on this device ──

interface DeviceExportInput {
  now: number
  accountKey: string | null
  deviceKey: string | null
  profile: storage.Profile | null
  servers: storage.SavedServer[]
  friends: storage.StoredFriend[]
  blocks: unknown[]
  dms: Record<string, storage.StoredDm[]>
  groups: storage.StoredGroup[]
  /** Saved messages (state/saved.ts), as kept on this device. */
  saved?: unknown[]
}

/** A DM as exported: what was said and when; attachment keys and call internals stay on the device. */
function plainMessage(m: storage.StoredDm) {
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    sentAt: m.sentAt,
    text: m.text,
    ...(m.call ? { call: true } : {}),
    ...(m.notice ? { notice: m.notice } : {}),
    ...(m.forward ? { forwarded: true } : {}),
    ...(Array.isArray(m.files) && m.files.length > 0 ? { attachments: m.files.length } : {}),
  }
}

/**
 * What this device keeps, readable: your public keys, profile, servers, friends, block list and the decrypted history of
 * your DMs and group chats. Never secret keys, recovery keys, prekeys or attachment keys.
 */
export function buildDeviceExport(input: DeviceExportInput) {
  const { profile } = input
  return {
    format: 'iskra-device-export/v1',
    exportedAt: input.now,
    account: { accountKey: input.accountKey, deviceKey: input.deviceKey },
    profile: profile
      ? { name: profile.name, bio: profile.bio ?? null, pronouns: profile.pronouns ?? null, accent: profile.accent ?? null, hasAvatar: !!profile.avatar }
      : null,
    servers: input.servers.map((s) => ({ name: s.name, url: s.url, serverKey: s.serverKey })),
    friends: input.friends.map((f) => ({ accountKey: f.accountKey, name: f.name, addedAt: f.addedAt })),
    blocks: input.blocks,
    directMessages: Object.entries(input.dms).map(([peer, messages]) => ({ peer, messages: messages.map(plainMessage) })),
    groups: input.groups.map((g) => ({
      serverKey: g.serverKey,
      id: g.id,
      name: g.name,
      members: g.names ?? {},
      messages: g.messages.map(plainMessage),
    })),
    savedMessages: (input.saved ?? []).flatMap((raw) => {
      const e = raw as { ref?: unknown; savedAt?: unknown; removedAt?: unknown; snap?: unknown } | null
      return e && e.ref && !e.removedAt ? [{ message: e.ref, savedAt: e.savedAt, snapshot: e.snap ?? null }] : []
    }),
  }
}

/** Reads the device's storage (decrypting it with the vault, which is open while the app runs). */
export async function collectDeviceExport(now = Date.now()) {
  const identity = useApp.getState().identity
  const [profile, servers, friends, blocks, dms, groups, saved] = await Promise.all([
    storage.loadProfile(), storage.loadServers(), storage.loadFriends(), storage.loadBlocks(), storage.loadDmHistory(), storage.loadGroups(),
    storage.loadPrivate<unknown[]>('saved').catch(() => undefined),
  ])
  // The saved list gets a server's name a moment after joining; the live one is newer.
  const live = useApp.getState().servers
  return buildDeviceExport({
    now,
    accountKey: identity ? b64u(identity.account.publicKey) : null,
    deviceKey: identity ? b64u(identity.device.publicKey) : null,
    profile: profile ?? null,
    servers: servers.map((s) => ({ ...s, name: live[s.serverKey]?.name || s.name })),
    friends,
    blocks,
    dms,
    groups,
    saved: Array.isArray(saved) ? saved : [],
  })
}

/** Saves JSON as a file download. */
export function saveJson(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const dateStamp = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)
