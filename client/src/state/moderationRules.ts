// Pure rules for blocks, timeouts, slowmode and audit entries (no React, no socket), mirrored from the server.
import type { AuditEntry, BlockEntry, Member } from '../core/protocol'
import { t } from '../i18n'
import { formatDate } from '../i18n/format'
import { levelName } from './permissions'

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
  { ms: 60_000 },
  { ms: 5 * 60_000 },
  { ms: 3_600_000 },
  { ms: 86_400_000 },
  { ms: 7 * 86_400_000 },
] as const

/** "60 seconds", "5 minutes", "1 hour", "1 day", "1 week"; other lengths in minutes. */
export function durationLabel(ms: number): string {
  switch (ms) {
    case 60_000: return t('moderation.duration.seconds', { count: 60 })
    case 5 * 60_000: return t('moderation.duration.minutes', { count: 5 })
    case 3_600_000: return t('moderation.duration.hours', { count: 1 })
    case 86_400_000: return t('moderation.duration.days', { count: 1 })
    case 7 * 86_400_000: return t('moderation.duration.weeks', { count: 1 })
    default: return t('moderation.duration.minutes', { count: Math.round(ms / 60_000) })
  }
}

export const timeoutActive = (member: Pick<Member, 'timedOutUntil'> | null | undefined, now = Date.now()): boolean =>
  !!member?.timedOutUntil && member.timedOutUntil > now

/** "14:05" today, "Tue 14:05" this week, else a date. */
export function untilText(until: number, now = Date.now()): string {
  const date = new Date(until)
  const time = formatDate(date, { hour: '2-digit', minute: '2-digit' })
  if (new Date(now).toDateString() === date.toDateString()) return time
  if (until - now < 6 * 86_400_000) return `${formatDate(date, { weekday: 'short' })} ${time}`
  return `${formatDate(date, { day: 'numeric', month: 'short' })} ${time}`
}

// ── Slowmode ────────────────────────────────────────────────────────────────

export const SLOWMODE_STEPS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600] as const

/** "Off", "5 s", "2 min", "6 h". */
export function slowmodeLabel(seconds: number): string {
  if (seconds <= 0) return t('moderation.slowmode.off')
  if (seconds < 60) return t('moderation.slowmode.seconds', { n: seconds })
  if (seconds < 3600) return t('moderation.slowmode.minutes', { n: seconds / 60 })
  return t('moderation.slowmode.hours', { n: seconds / 3600 })
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
export const AUDIT_ACTIONS = [
  'member.kick', 'member.ban', 'member.unban', 'member.timeout', 'member.timeout.remove', 'member.role', 'member.roles',
  'role.create', 'role.update', 'role.delete', 'role.reorder', 'channel.overrides', 'voice.mute', 'voice.move', 'voice.disconnect',
  'channel.create', 'channel.update', 'channel.delete', 'message.delete', 'thread.delete', 'message.pin', 'message.unpin',
  'invite.create', 'invite.revoke', 'webhook.create', 'webhook.update', 'webhook.regenerate', 'webhook.delete', 'bot.invite',
  'emoji.create', 'emoji.rename', 'emoji.delete', 'sound.create', 'sound.update', 'sound.delete',
  'profile.page.remove', 'server.pages', 'server.internet', 'limits.update', 'buginbox.update', 'afk.update', 'automod.block', 'automod.update',
  'report.resolve', 'owner.transfer', 'docs.page.create', 'docs.page.delete', 'docs.page.restore', 'docs.home.set',
] as const

export type AuditFilter = (typeof AUDIT_ACTIONS)[number]
type Underscored<S extends string> = S extends `${infer A}.${infer B}` ? `${A}_${Underscored<B>}` : S

/** A filter's label ("Kicks"). */
export const auditActionLabel = (action: AuditFilter): string =>
  t(`moderation.audit.filters.${action.replace(/\./g, '_') as Underscored<AuditFilter>}`)

const AUTOMOD_WHAT = ['message', 'edit', 'poll', 'post', 'thread', 'event', 'watch', 'page'] as const

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

/** One readable line: "Viktor timed out Sam for 1 hour". Names come from the entry (they survive people leaving). */
export function auditText(e: AuditEntry): string {
  const actor = e.actorName || t('moderation.audit.someone')
  const target = e.targetName ?? t('moderation.audit.someoneLower')
  const d = e.details ?? {}
  const channel = (name: unknown) => (str(name) ? `#${str(name)}` : t('moderation.audit.aChannel'))
  const changes = (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>
  const level = (v: unknown) => levelName(str(v))
  switch (e.action) {
    case 'member.kick': return t('moderation.audit.kick', { actor, target })
    case 'member.ban': return t('moderation.audit.ban', { actor, target })
    case 'member.unban': return t('moderation.audit.unban', { actor, target })
    case 'member.timeout': return t('moderation.audit.timeout', { actor, target, duration: durationLabel(Number(d.durationMs)) })
    case 'member.timeout.remove': return t('moderation.audit.timeoutRemove', { actor, target })
    case 'member.role': return t('moderation.audit.role', { actor, target, from: level(d.from), to: level(d.to) })
    case 'member.roles': {
      const list = (v: unknown) => (Array.isArray(v) ? v.map(str).join(', ') : '')
      const added = list(d.added)
      const removed = list(d.removed)
      if (added && removed) return t('moderation.audit.rolesBoth', { actor, target, added, removed })
      if (added) return t('moderation.audit.rolesAdded', { actor, target, added })
      if (removed) return t('moderation.audit.rolesRemoved', { actor, target, removed })
      return t('moderation.audit.rolesChanged', { actor, target })
    }
    case 'role.create': return t('moderation.audit.roleCreate', { actor, name: str(d.name) })
    case 'role.update': return t('moderation.audit.roleUpdate', { actor, name: str(d.name) })
    case 'role.delete': return t('moderation.audit.roleDelete', { actor, name: str(d.name) })
    case 'role.reorder': return t('moderation.audit.roleReorder', { actor })
    case 'channel.overrides': return t('moderation.audit.overrides', { actor, role: str(d.role), channel: channel(d.name) })
    case 'voice.mute': return t('moderation.audit.voiceMute', { actor, target, channel: channel(d.channelName) })
    case 'voice.unmute': return t('moderation.audit.voiceUnmute', { actor, target, channel: channel(d.channelName) })
    case 'voice.move': return t('moderation.audit.voiceMove', { actor, target, channel: channel(d.to) })
    case 'voice.disconnect': return t('moderation.audit.voiceDisconnect', { actor, target, channel: channel(d.channelName) })
    case 'bot.voice': return t(d.voice ? 'moderation.audit.botVoiceOn' : 'moderation.audit.botVoiceOff', { actor, target })
    case 'channel.create': return t('moderation.audit.channelCreate', { actor, channel: channel(d.name) })
    case 'channel.delete': return t('moderation.audit.channelDelete', { actor, channel: channel(d.name) })
    case 'channel.update': {
      const parts = Object.entries(changes).map(([field, c]) => {
        if (field === 'slowmode') {
          return t('moderation.audit.changeSlowmode', {
            from: slowmodeLabel(Number(c.from)).toLowerCase(), to: slowmodeLabel(Number(c.to)).toLowerCase(),
          })
        }
        if (field === 'name') return t('moderation.audit.changeName', { from: str(c.from), to: str(c.to) })
        return t(field === 'readRole' ? 'moderation.audit.changeRead' : 'moderation.audit.changeWrite', { from: level(c.from), to: level(c.to) })
      })
      return parts.length
        ? t('moderation.audit.channelUpdateChanges', { actor, channel: channel(d.name), changes: parts.join(', ') })
        : t('moderation.audit.channelUpdate', { actor, channel: channel(d.name) })
    }
    case 'message.delete':
      return t('moderation.audit.messageDelete', { actor, target: e.targetName ?? t('moderation.audit.formerMember'), channel: channel(d.channelName) })
    case 'thread.delete': return t('moderation.audit.threadDelete', { actor, target, name: str(d.name), channel: channel(d.channelName) })
    case 'message.pin':
      return e.targetName
        ? t('moderation.audit.pinBy', { actor, target: e.targetName, channel: channel(d.channelName) })
        : t('moderation.audit.pin', { actor, channel: channel(d.channelName) })
    case 'message.unpin':
      return e.targetName
        ? t('moderation.audit.unpinBy', { actor, target: e.targetName, channel: channel(d.channelName) })
        : t('moderation.audit.unpin', { actor, channel: channel(d.channelName) })
    case 'invite.create': {
      const role = level(d.role || 'member')
      return d.maxUses
        ? t('moderation.audit.inviteCreateUses', { actor, role, count: Number(d.maxUses) })
        : t('moderation.audit.inviteCreate', { actor, role })
    }
    case 'invite.revoke':
      return e.target === e.actor ? t('moderation.audit.inviteRevokeOwn', { actor }) : t('moderation.audit.inviteRevoke', { actor, target })
    case 'webhook.create': return t('moderation.audit.webhookCreate', { actor, name: str(d.name) })
    case 'webhook.update': return t('moderation.audit.webhookUpdate', { actor, name: str(d.name) })
    case 'webhook.regenerate': return t('moderation.audit.webhookRegenerate', { actor, name: str(d.name) })
    case 'webhook.delete': return t('moderation.audit.webhookDelete', { actor, name: str(d.name) })
    case 'bot.invite': return t(d.readAll ? 'moderation.audit.botInviteReadAll' : 'moderation.audit.botInvite', { actor, role: level(d.role) })
    case 'bot.scope': return t(d.readAll ? 'moderation.audit.botScopeAll' : 'moderation.audit.botScopeMentions', { actor, target })
    case 'emoji.create': return t('moderation.audit.emojiCreate', { actor, name: str(d.name) })
    case 'emoji.rename': return t('moderation.audit.emojiRename', { actor, from: str(d.from), to: str(d.to) })
    case 'emoji.delete': return t('moderation.audit.emojiDelete', { actor, name: str(d.name) })
    case 'sound.create': return t('moderation.audit.soundCreate', { actor, name: str(d.name) })
    case 'sound.update': return t('moderation.audit.soundUpdate', { actor, name: str(d.to) })
    case 'sound.delete': return t('moderation.audit.soundDelete', { actor, name: str(d.name) })
    case 'profile.page.remove': return t('moderation.audit.pageRemove', { actor, target })
    case 'server.pages': return t(d.enabled ? 'moderation.audit.pagesOn' : 'moderation.audit.pagesOff', { actor })
    case 'server.internet': return t(d.enabled ? 'moderation.audit.internetOn' : 'moderation.audit.internetOff', { actor })
    case 'limits.update': return t('moderation.audit.limits', { actor })
    case 'buginbox.update': return t(d.enabled ? 'moderation.audit.bugInboxOn' : 'moderation.audit.bugInboxOff', { actor })
    case 'afk.update': return t('moderation.audit.afk', { actor })
    case 'automod.update': return t(d.enabled ? 'moderation.audit.automodUpdate' : 'moderation.audit.automodOff', { actor })
    case 'report.resolve': {
      const outcome = ['dismissed', 'deleted', 'timeout', 'kick', 'ban', 'other'].includes(str(d.outcome)) ? str(d.outcome) as 'other' : 'other'
      return t('moderation.audit.reportResolve', { actor, target, outcome: t(`safety.outcomes.${outcome}`) })
    }
    case 'owner.transfer': return t('moderation.audit.ownerTransfer', { actor, target })
    case 'docs.page.create': return t('moderation.audit.docsPageCreate', { actor, title: str(d.title), channel: channel(d.channelName) })
    case 'docs.page.delete': return t('moderation.audit.docsPageDelete', { actor, title: str(d.title), channel: channel(d.channelName) })
    case 'docs.page.restore': {
      const version = str((d.extra as Record<string, unknown> | null)?.version)
      return t('moderation.audit.docsPageRestore', { actor, title: str(d.title), channel: channel(d.channelName), version })
    }
    case 'docs.home.set': return d.pageId ? t('moderation.audit.docsHomeSet', { actor, title: str(d.title) }) : t('moderation.audit.docsHomeClear', { actor })
    case 'automod.block': {
      const kind = AUTOMOD_WHAT.find((w) => w === str(d.what)) ?? 'message'
      const vars = {
        what: t(`moderation.audit.what.${kind}`),
        target,
        channel: channel(d.channelName),
        reason: e.reason ?? t('moderation.audit.aRule'),
        duration: durationLabel(Number(d.timeoutMs)),
      }
      const where = !!str(d.channelName)
      const timeout = Number(d.timeoutMs) > 0
      if (where && timeout) return t('moderation.audit.automodBlockInTimeout', vars)
      if (where) return t('moderation.audit.automodBlockIn', vars)
      if (timeout) return t('moderation.audit.automodBlockTimeout', vars)
      return t('moderation.audit.automodBlock', vars)
    }
    default: return t('moderation.audit.other', { actor, action: e.action })
  }
}
