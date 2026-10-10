// Non-component helpers for bot and webhook messages.
import type { FileInfo, Member, Message } from '../../core/protocol'

export interface AuthorInfo {
  name: string
  /** Bots and webhooks get a BOT badge. */
  bot: boolean
  /** A webhook's avatar image, if it has one. */
  avatar: FileInfo | null
}

/** Who wrote a message, as shown above it: a webhook's name, a member, or a former member. */
export function authorOf(message: Pick<Message, 'author' | 'webhook'>, members: Record<string, Member>): AuthorInfo {
  if (message.webhook) return { name: message.webhook.name, bot: true, avatar: message.webhook.avatar }
  const member = members[message.author]
  if (message.author.startsWith('webhook:')) return { name: 'Webhook', bot: true, avatar: null }
  return { name: member?.name ?? 'Former member', bot: !!member?.bot, avatar: null }
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
