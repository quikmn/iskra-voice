// Pure rules for blocks, timeouts, slowmode and audit entries (no React, no socket), mirrored from the server.
import type { AuditEntry, BlockEntry, Member } from '../core/protocol'

/** Per person the newest change wins; on a tie a block beats an unblock (same rule as the server). */
export function mergeBlocks(...lists: BlockEntry[][]): BlockEntry[] {
  const byKey = new Map<string, BlockEntry>()
  for (const list of lists) {
    for (const entry of list) {
      const current = byKey.get(entry.accountKey)
      if (current && (current.at > entry.at || (current.at === entry.at && (current.blocked || !entry.blocked)))) continue
      byKey.set(entry.accountKey, entry)
    }
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at || a.accountKey.localeCompare(b.accountKey))
}

export function sameBlocks(a: BlockEntry[], b: BlockEntry[]): boolean {
  if (a.length !== b.length) return false
  const byKey = new Map(a.map((e) => [e.accountKey, e]))
  return b.every((e) => {
    const other = byKey.get(e.accountKey)
    return !!other && other.blocked === e.blocked && other.at === e.at
  })
}

export const blockedKeys = (entries: BlockEntry[]): string[] => entries.filter((e) => e.blocked).map((e) => e.accountKey)

/** A new change for one person, always newer than what we had (clocks can be behind). */
export function blockChange(entries: BlockEntry[], accountKey: string, blocked: boolean, now = Date.now()): BlockEntry[] {
  const previous = entries.find((e) => e.accountKey === accountKey)
  return mergeBlocks(entries, [{ accountKey, blocked, at: Math.max(now, (previous?.at ?? 0) + 1) }])
}

// ── Timeouts ────────────────────────────────────────────────────────────────

export const TIMEOUT_OPTIONS = [
  { label: '60 seconds', ms: 60_000 },
  { label: '5 minutes', ms: 5 * 60_000 },
  { label: '1 hour', ms: 3_600_000 },
  { label: '1 day', ms: 86_400_000 },
  { label: '1 week', ms: 7 * 86_400_000 },
] as const

export const timeoutActive = (member: Pick<Member, 'timedOutUntil'> | null | undefined, now = Date.now()): boolean =>
  !!member?.timedOutUntil && member.timedOutUntil > now

/** "14:05" today, "Tue 14:05" this week, else a date. */
export function untilText(until: number, now = Date.now()): string {
  const date = new Date(until)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (new Date(now).toDateString() === date.toDateString()) return time
  if (until - now < 6 * 86_400_000) return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

// ── Slowmode ────────────────────────────────────────────────────────────────

export const SLOWMODE_STEPS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600] as const

/** "Off", "5 s", "2 min", "6 h". */
export function slowmodeLabel(seconds: number): string {
  if (seconds <= 0) return 'Off'
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${seconds / 60} min`
  return `${seconds / 3600} h`
}

/** How long until you may send again (0 = now). */
export function slowmodeWait(seconds: number | undefined, lastSentAt: number | undefined, now = Date.now()): number {
  if (!seconds || !lastSentAt) return 0
  return Math.max(0, lastSentAt + seconds * 1000 - now)
}

/** A countdown: "0:09", "4:59", "1:02:03". */
export function countdown(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

// ── Audit log ───────────────────────────────────────────────────────────────

/** Filter choices in the audit log viewer. */
export const AUDIT_ACTIONS: { action: string; label: string }[] = [
  { action: 'member.kick', label: 'Kicks' },
  { action: 'member.ban', label: 'Bans' },
  { action: 'member.unban', label: 'Unbans' },
  { action: 'member.timeout', label: 'Timeouts' },
  { action: 'member.timeout.remove', label: 'Timeouts removed' },
  { action: 'member.role', label: 'Role changes' },
  { action: 'channel.create', label: 'Channels created' },
  { action: 'channel.update', label: 'Channels edited' },
  { action: 'channel.delete', label: 'Channels deleted' },
  { action: 'message.delete', label: 'Messages deleted' },
  { action: 'thread.delete', label: 'Threads deleted' },
  { action: 'message.pin', label: 'Pins' },
  { action: 'message.unpin', label: 'Unpins' },
  { action: 'invite.create', label: 'Invites created' },
  { action: 'invite.revoke', label: 'Invites revoked' },
  { action: 'webhook.create', label: 'Webhooks created' },
  { action: 'webhook.update', label: 'Webhooks edited' },
  { action: 'webhook.regenerate', label: 'Webhook URLs reset' },
  { action: 'webhook.delete', label: 'Webhooks deleted' },
  { action: 'bot.invite', label: 'Bot invites' },
  { action: 'emoji.create', label: 'Emoji added' },
  { action: 'emoji.rename', label: 'Emoji renamed' },
  { action: 'emoji.delete', label: 'Emoji deleted' },
  { action: 'sound.create', label: 'Sounds added' },
  { action: 'sound.update', label: 'Sounds edited' },
  { action: 'sound.delete', label: 'Sounds deleted' },
  { action: 'profile.page.remove', label: 'Profile pages removed' },
  { action: 'server.pages', label: 'Profile page setting' },
  { action: 'server.internet', label: 'Internet hosting' },
]

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const durationText = (ms: number) => TIMEOUT_OPTIONS.find((o) => o.ms === ms)?.label ?? `${Math.round(ms / 60_000)} minutes`

/** One readable line: "Viktor timed out Sam for 1 hour". Names come from the entry (they survive people leaving). */
export function auditText(e: AuditEntry): string {
  const actor = e.actorName || 'Someone'
  const target = e.targetName ?? 'someone'
  const d = e.details ?? {}
  const channel = (name: unknown) => (str(name) ? `#${str(name)}` : 'a channel')
  const changes = (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>
  switch (e.action) {
    case 'member.kick': return `${actor} kicked ${target}`
    case 'member.ban': return `${actor} banned ${target}`
    case 'member.unban': return `${actor} unbanned ${target}`
    case 'member.timeout': return `${actor} timed out ${target} for ${durationText(Number(d.durationMs))}`
    case 'member.timeout.remove': return `${actor} ended ${target}'s timeout`
    case 'member.role': return `${actor} changed ${target}'s role from ${str(d.from)} to ${str(d.to)}`
    case 'channel.create': return `${actor} created ${channel(d.name)}`
    case 'channel.delete': return `${actor} deleted ${channel(d.name)}`
    case 'channel.update': {
      const parts = Object.entries(changes).map(([field, c]) => {
        if (field === 'slowmode') return `slowmode ${slowmodeLabel(Number(c.from)).toLowerCase()} → ${slowmodeLabel(Number(c.to)).toLowerCase()}`
        if (field === 'name') return `name #${str(c.from)} → #${str(c.to)}`
        return `${field === 'readRole' ? 'who can read' : 'who can write'} ${str(c.from)} → ${str(c.to)}`
      })
      return `${actor} edited ${channel(d.name)}${parts.length ? `: ${parts.join(', ')}` : ''}`
    }
    case 'message.delete': return `${actor} deleted a message by ${e.targetName ?? 'a webhook or former member'} in ${channel(d.channelName)}`
    case 'thread.delete': return `${actor} deleted ${target}'s thread "${str(d.name)}" in ${channel(d.channelName)}`
    case 'message.pin': return `${actor} pinned a message${e.targetName ? ` by ${e.targetName}` : ''} in ${channel(d.channelName)}`
    case 'message.unpin': return `${actor} unpinned a message${e.targetName ? ` by ${e.targetName}` : ''} in ${channel(d.channelName)}`
    case 'invite.create': return `${actor} created an invite (${str(d.role) || 'member'}${d.maxUses ? `, ${str(d.maxUses)} uses` : ''})`
    case 'invite.revoke': return `${actor} revoked ${e.target === e.actor ? 'their' : `${target}'s`} invite`
    case 'webhook.create': return `${actor} created the webhook "${str(d.name)}"`
    case 'webhook.update': return `${actor} edited the webhook "${str(d.name)}"`
    case 'webhook.regenerate': return `${actor} reset the URL of the webhook "${str(d.name)}"`
    case 'webhook.delete': return `${actor} deleted the webhook "${str(d.name)}"`
    case 'bot.invite': return `${actor} created a bot invite (${str(d.role)})`
    case 'emoji.create': return `${actor} added the emoji :${str(d.name)}:`
    case 'emoji.rename': return `${actor} renamed the emoji :${str(d.from)}: to :${str(d.to)}:`
    case 'emoji.delete': return `${actor} deleted the emoji :${str(d.name)}:`
    case 'sound.create': return `${actor} added the sound "${str(d.name)}"`
    case 'sound.update': return `${actor} edited the sound "${str(d.to)}"`
    case 'sound.delete': return `${actor} deleted the sound "${str(d.name)}"`
    case 'profile.page.remove': return `${actor} removed ${target}'s profile page`
    case 'server.pages': return `${actor} turned profile pages ${d.enabled ? 'on' : 'off'}`
    case 'server.internet': return `${actor} turned internet hosting ${d.enabled ? 'on' : 'off'}`
    default: return `${actor}: ${e.action}`
  }
}
