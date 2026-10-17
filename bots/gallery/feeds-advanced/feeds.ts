// Feeds-advanced's rules, apart from the bot (bot.ts) so they're easy to test: reading RSS and Atom, keyword filters,
// which addresses the bot may fetch, and what it remembers.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface FeedItem {
  /** The item's guid or id (else its link, else its title): how the bot knows it posted it already. */
  id: string
  title: string
  link: string | null
  /** The text of its summary or description, without HTML (for the keyword filters). */
  summary: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Decodes the XML entities and CDATA in a piece of text and drops any HTML tags. */
export function plainText(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // Entities first (descriptions are often escaped HTML), then the tags they revealed.
  const decoded = unwrapped.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return match ? match[1] : null
}

/** The items of an RSS 2.0 or Atom feed (YouTube channel feeds are Atom), newest first as the feed lists them. */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = []
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? []
  for (const block of blocks.slice(0, 100)) {
    const title = plainText(tag(block, 'title') ?? '').slice(0, 300)
    // RSS: <link>https://…</link>. Atom: <link rel="alternate" href="…"/> (or the first link with an href).
    let link = plainText(tag(block, 'link') ?? '') || null
    if (!link) {
      const alternate = /<link\b[^>]*rel=["']alternate["'][^>]*>/i.exec(block)?.[0] ?? /<link\b[^>]*href=[^>]*>/i.exec(block)?.[0]
      link = alternate ? plainText(/href=["']([^"']+)["']/i.exec(alternate)?.[1] ?? '') || null : null
    }
    if (link && !/^https?:\/\//i.test(link)) link = null
    const summary = plainText(tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content') ?? tag(block, 'media:description') ?? '').slice(0, 1000)
    const id = plainText(tag(block, 'guid') ?? tag(block, 'id') ?? '') || link || title
    if (id && (title || link)) items.push({ id: id.slice(0, 500), title: title || link!, link, summary })
  }
  return items
}

/** "rust, go , Zig" → ["rust", "go", "zig"] (up to 20 words of up to 40 characters). */
export function keywords(text: string | undefined | null): string[] {
  return (text ?? '').split(',').map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0).map((k) => k.slice(0, 40)).slice(0, 20)
}

/**
 * Whether an item passes a feed's filters: none of the `exclude` words, and (if there are `include` words) at least
 * one of them, in its title or summary. Words match whole words, ignoring case ("go" doesn't match "good").
 */
export function passes(item: FeedItem, include: string[], exclude: string[]): boolean {
  const text = `${item.title} ${item.summary}`.toLowerCase()
  const has = (word: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text)
  if (exclude.some(has)) return false
  return include.length === 0 || include.some(has)
}

/**
 * Addresses on this computer or its network (localhost, 10.x, 192.168.x, link-local, …). The bot never fetches them:
 * otherwise an admin's typo, or a feed that redirects, could make it poke at the operator's router or other machines.
 */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  const v6 = ip.toLowerCase()
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7))
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff')
}

/** Checks a feed address: http(s), no user name or password, and a host that isn't on this computer's network. */
export async function checkAddress(url: string, allowPrivate = false, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'That isn\'t a web address.'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'Only http and https addresses work.'
  if (parsed.username || parsed.password) return 'Leave the user name and password out of the address.'
  if (allowPrivate) return null
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [])
  if (addresses.length === 0) return `Couldn't find ${host}.`
  if (addresses.some(isPrivateAddress)) return 'That address is on a private network; feeds come from the internet only.'
  return null
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address)
}

export const MAX_FEED_BYTES = 2 * 1024 * 1024

/**
 * Fetches a feed: at most 2 MB, 15 seconds, and up to 3 redirects, each checked like the address itself. The bot
 * never sends cookies or anything about the server; sites see the operator's IP address, like any feed reader.
 */
export async function fetchFeed(url: string, allowPrivate = false, fetcher: typeof fetch = fetch): Promise<string> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    const problem = await checkAddress(current, allowPrivate)
    if (problem) throw new Error(problem)
    const response = await fetcher(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'IskraFeedsBot/1.0 (+https://iskra.foo/docs/bots)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location')!, current).toString()
      continue
    }
    if (!response.ok) throw new Error(`The site answered ${response.status}.`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_FEED_BYTES) throw new Error('That feed is over 2 MB.')
    const reader = response.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_FEED_BYTES) {
        await reader.cancel()
        throw new Error('That feed is over 2 MB.')
      }
      chunks.push(value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks))
  }
  throw new Error('Too many redirects.')
}

/** A feed followed in a channel. */
export interface Feed {
  id: number
  url: string
  channelId: number
  include: string[]
  exclude: string[]
  /** Item ids already seen (the newest 300), so only new items are posted. */
  seen: string[]
  /** Set when the last fetch failed (shown in /feed list). */
  error?: string | null
}

/** A Twitch channel announced in an Iskra channel when it goes live. */
export interface TwitchAlert {
  login: string
  channelId: number
}

export interface FeedsState {
  nextId: number
  feeds: Feed[]
  alerts: TwitchAlert[]
  /** Twitch login → account keys of the people who want a DM when it goes live (their own choice, /twitch follow). */
  follows: Record<string, string[]>
  /** Twitch logins live right now (with the stream's id), so a stream is announced once. */
  live: Record<string, string>
}

export const LIMITS = { feeds: 50, alerts: 50, followsPerPerson: 20, seen: 300 }

/** What the bot remembers, in one JSON file. */
export class Store {
  state: FeedsState = { nextId: 1, feeds: [], alerts: [], follows: {}, live: {} }
  private readonly file: string | null

  constructor(file: string | null) {
    this.file = file
    if (!file) return
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<FeedsState>
      this.state = { ...this.state, ...saved }
    } catch {
      /* first run */
    }
  }

  /** Marks items as seen; returns the ones that are new (oldest first, so they're posted in order). */
  newItems(feed: Feed, items: FeedItem[]): FeedItem[] {
    const seen = new Set(feed.seen)
    const fresh = items.filter((i) => !seen.has(i.id))
    feed.seen = [...items.map((i) => i.id), ...feed.seen.filter((id) => !items.some((i) => i.id === id))].slice(0, LIMITS.seen)
    return fresh.reverse()
  }

  follow(login: string, user: string): 'added' | 'already' | 'full' {
    const list = (this.state.follows[login] ??= [])
    if (list.includes(user)) return 'already'
    if (Object.values(this.state.follows).filter((l) => l.includes(user)).length >= LIMITS.followsPerPerson) return 'full'
    list.push(user)
    return 'added'
  }

  unfollow(login: string, user: string): boolean {
    const list = this.state.follows[login] ?? []
    if (!list.includes(user)) return false
    this.state.follows[login] = list.filter((u) => u !== user)
    if (this.state.follows[login].length === 0) delete this.state.follows[login]
    return true
  }

  /** Every Twitch login anyone is waiting for. */
  watched(): string[] {
    return [...new Set([...this.state.alerts.map((a) => a.login), ...Object.keys(this.state.follows)])]
  }

  save(): void {
    if (!this.file) return
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2))
    renameSync(`${this.file}.tmp`, this.file)
  }
}

/** Twitch logins: 4-25 letters, digits and underscores ("https://twitch.tv/Name" works too). */
export function twitchLogin(text: string): string | null {
  const login = text.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/\/.*$/, '').toLowerCase()
  return /^[a-z0-9_]{3,25}$/.test(login) ? login : null
}
