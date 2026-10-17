// Feeds (the built-in bot that posts new posts, videos and streams): pure helpers for its settings and its posts.
import type { BuiltinReply, FeedFields, FeedKind, FeedMention, FeedReply, FeedSubscription } from '../core/protocol'

export const FEED_KINDS: readonly FeedKind[] = ['rss', 'youtube', 'twitch']
export const MAX_FEED_TEMPLATE = 500
export const MAX_FEED_SOURCE = 512

/** Check intervals in minutes, as the server allows them. */
export const FEED_INTERVALS: Record<FeedKind, { min: number; max: number; default: number }> = {
  rss: { min: 5, max: 1440, default: 15 },
  youtube: { min: 5, max: 1440, default: 15 },
  twitch: { min: 2, max: 60, default: 3 },
}

/** The kind a pasted address most likely is (YouTube and Twitch addresses), else RSS. */
export function guessKind(source: string): FeedKind {
  const s = source.trim().toLowerCase()
  if (/^uc[a-z0-9_-]{22}$/i.test(source.trim()) || /(^|\/\/|\.)youtube\.com\//.test(s) || /^youtube\.com/.test(s)) return 'youtube'
  if (/(^|\/\/|\.)twitch\.tv(\/|$)/.test(s)) return 'twitch'
  return 'rss'
}

/** What's wrong with a source before sending it (an i18n key under feeds.invalid), or null. */
export function sourceProblem(kind: FeedKind, source: string): 'empty' | 'long' | 'youtube' | 'twitch' | 'url' | null {
  const s = source.trim()
  if (!s) return 'empty'
  if (s.length > MAX_FEED_SOURCE) return 'long'
  if (kind === 'youtube') {
    if (/^UC[A-Za-z0-9_-]{22}$/.test(s) || /^@[A-Za-z0-9._-]{1,100}$/.test(s)) return null
    return /(^|\/\/|\.)youtube\.com\/(channel\/|@|c\/|user\/|feeds\/)/i.test(s) ? null : 'youtube'
  }
  if (kind === 'twitch') {
    const login = s.replace(/^@/, '')
    if (/^[A-Za-z0-9_]{1,25}$/.test(login)) return null
    return /(^|\/\/|\.)twitch\.tv\/[A-Za-z0-9_]{1,25}\/?$/i.test(s) ? null : 'twitch'
  }
  if (/\s/.test(s)) return 'url'
  const withScheme = s.includes('://') ? s : `https://${s}`
  try {
    const url = new URL(withScheme)
    const web = url.protocol === 'http:' || url.protocol === 'https:'
    const host = url.hostname.includes('.') || url.hostname === 'localhost' || url.hostname.startsWith('[')
    return web && !url.username && !url.password && host ? null : 'url'
  } catch {
    return 'url'
  }
}

/** What's wrong with the fields (an i18n key under feeds.invalid), or null. */
export function fieldsProblem(kind: FeedKind, fields: FeedFields): 'interval' | 'template' | 'placeholder' | 'role' | 'channel' | null {
  const { min, max } = FEED_INTERVALS[kind]
  if (!fields.channelId) return 'channel'
  if (!Number.isInteger(fields.intervalMinutes) || fields.intervalMinutes < min || fields.intervalMinutes > max) return 'interval'
  if (fields.template.trim().length > MAX_FEED_TEMPLATE) return 'template'
  if (/[@<&]\{(title|name|url)\}/.test(fields.template)) return 'placeholder' // the server refuses these too
  if (fields.mention === 'role' && !fields.mentionRoleId) return 'role'
  return null
}

/** The editable fields of a subscription. */
export function fieldsOf(sub: FeedSubscription): FeedFields {
  return { channelId: sub.channelId, mention: sub.mention, mentionRoleId: sub.mentionRoleId, template: sub.template, intervalMinutes: sub.intervalMinutes }
}

/** Only what changed, ready for feeds.update (a mention goes with its role). */
export function fieldsPatch(saved: FeedFields, draft: FeedFields): Partial<FeedFields> {
  const patch: Partial<FeedFields> = {}
  if (draft.channelId !== saved.channelId) patch.channelId = draft.channelId
  if (draft.mention !== saved.mention || (draft.mention === 'role' && draft.mentionRoleId !== saved.mentionRoleId)) {
    patch.mention = draft.mention
    if (draft.mention === 'role') patch.mentionRoleId = draft.mentionRoleId
  }
  if (draft.template.trim() !== saved.template.trim()) patch.template = draft.template.trim()
  if (draft.intervalMinutes !== saved.intervalMinutes) patch.intervalMinutes = draft.intervalMinutes
  return patch
}

/** The select value for a mention ("", "everyone", "here" or "role:<id>"), and back. */
export function mentionValue(mention: FeedMention | null, roleId: number | null): string {
  return mention === 'role' ? `role:${roleId ?? ''}` : mention ?? ''
}

export function parseMentionValue(value: string): { mention: FeedMention | null; mentionRoleId: number | null } {
  if (value === 'everyone' || value === 'here') return { mention: value, mentionRoleId: null }
  const role = /^role:(\d+)$/.exec(value)
  return role ? { mention: 'role', mentionRoleId: Number(role[1]) } : { mention: null, mentionRoleId: null }
}

/** The mention as message markup (rendered as a mention chip). */
export function mentionToken(mention: FeedMention | null, roleId: number | null): string | null {
  if (mention === 'everyone') return '@everyone'
  if (mention === 'here') return '@here'
  if (mention === 'role' && roleId) return `<@&${roleId}>`
  return null
}

/** Only http(s) links are shown as links. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** The template filled in for the preview, as the server will fill it (mentions typed into it don't ping). */
export function fillFeedTemplate(template: string, values: { title: string; url: string; name: string }): string {
  const defused = template.replace(/@(everyone|here)\b/g, '@‍$1').split('<@').join('<‍@')
  return defused.split('{title}').join(values.title).split('{name}').join(values.name).split('{url}').join(values.url)
}

export function isFeedReply(reply: BuiltinReply): reply is BuiltinReply & FeedReply {
  return reply.kind === 'feed.item'
}

/** The i18n key of a post's default line. */
export function postKey(reply: FeedReply): string {
  return `feeds.post.${reply.source}`
}

export type FeedStatus = 'paused' | 'error' | 'ok' | 'new'

/** How a subscription is doing, for its status line. */
export function feedStatus(sub: FeedSubscription): FeedStatus {
  if (sub.paused) return 'paused'
  if (sub.lastError) return 'error'
  return sub.lastOkAt ? 'ok' : 'new'
}
