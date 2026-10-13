// Non-component helpers for bot and webhook messages.
import type { FileInfo, Member, Message } from '../../core/protocol'
import { resolveKey } from '../../state/keyMap'
import { t } from '../../i18n'

export interface AuthorInfo {
  name: string
  /** Bots and webhooks get a BOT badge. */
  bot: boolean
  /** One of the server's built-in bots (a BUILT-IN badge instead). */
  builtin?: boolean
  /** A webhook's avatar image, if it has one. */
  avatar: FileInfo | null
}

/** Who wrote a message, as shown above it: a webhook's name, a member, or a former member. */
export function authorOf(message: Pick<Message, 'author' | 'webhook' | 'imported' | 'builtin'>, members: Record<string, Member>): AuthorInfo {
  if (message.webhook) return { name: message.webhook.name, bot: true, avatar: message.webhook.avatar }
  if (message.author === 'automod:') return { name: 'AutoMod', bot: true, avatar: null }
  // Imported from Discord: the name and avatar it had there (not an account here).
  if (message.imported) return { name: message.imported.name, bot: message.imported.bot, avatar: message.imported.avatar }
  // A message from before its author replaced their account key: the server moved it, our cached copy may not have.
  const member = members[message.author] ?? members[resolveKey(message.author)]
  if (message.author.startsWith('webhook:')) return { name: t('chat.author.webhook'), bot: true, avatar: null }
  // A built-in bot that's been turned off still signs its old answers.
  if (!member && message.builtin) return { name: t(`builtinBots.names.${message.builtin.bot}`), bot: true, builtin: true, avatar: null }
  return { name: member?.name ?? t('chat.author.formerMember'), bot: !!member?.bot, builtin: !!member?.builtin, avatar: null }
}

/** Messages group under one header only when the same author posted them under the same name. */
export function sameSender(a: Pick<Message, 'author' | 'webhook'>, b: Pick<Message, 'author' | 'webhook'>): boolean {
  return a.author === b.author && (a.webhook?.name ?? null) === (b.webhook?.name ?? null)
}

/** An embed's colour as CSS, or null for the default. */
export function embedColor(color: number | undefined): string | null {
  if (color === undefined || !Number.isInteger(color) || color < 0 || color > 0xffffff) return null
  return `#${color.toString(16).padStart(6, '0')}`
}

/** Only http(s) links are ever made clickable (the server checks too). */
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

/** A card picture's address: this server's own files or a small data: image; anything else is never loaded. */
export function cardPictureUrl(serverUrl: string, url: string | undefined): string | null {
  if (!url) return null
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) return url
  if (/^\/files\/[\w-]{16,64}\/[^?#]*$/.test(url) && !url.includes('..')) return serverUrl + url
  return null
}
