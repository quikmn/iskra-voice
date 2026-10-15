// Chat formatting, Discord-style, rendered straight to React elements (never to an HTML string).
// Supported: ```code blocks``` (highlighted, with copy), `code`, **bold**, *italic* / _italic_, ~~strike~~, ||spoiler||,
// > quotes, # headings, -# subtext, - and 1. lists, links, [masked](https://…) links (they ask before opening),
// <t:unix:style> timestamps, mentions written as <@accountKey> (shown as @name) or <@&roleId> (@Role), and server emoji written as <:name:id>.
import { Fragment, type MouseEvent, type ReactNode } from 'react'
import { parseOpenRoute } from '../core/pushRoute'
import { roleRank, type Role } from '../core/protocol'
import { Spoiler } from './bits'
import { t } from '../i18n'
import { resolveKey } from '../state/keyMap'
import { userMenuProps } from './people/userMenuProps'
import { CUSTOM_EMOJI_SOURCE, isEmojiOnly } from './expressions/emoji'
import { CodeBlock, MaskedLink, Timestamp } from './chat/RichText'
import { TIMESTAMP_SOURCE, formatTimestamp, parseTimestamp, type TimestampStyle } from './chat/richTextRules'
import { alertRanges } from '../state/alertsLogic'

export interface MarkdownContext {
  /** Display name for a mentioned account, or null if unknown. */
  nameOf: (accountKey: string) => string | null
  /** The viewer's account, so mentions of them stand out. */
  me?: string
  /** Image URL of a server emoji by id, or null if it isn't (or is no longer) on the server. */
  emoji?: (id: string) => string | null
  /** A mentioned role: its name, colour, and whether the viewer has it. */
  roleOf?: (id: number) => { name: string; color: string | null; mine: boolean } | null
  /** The server the text is on, for the people menu on mentions (none in DMs). */
  serverKey?: string
  /** The viewer's alert words (state/alertsLogic.ts), marked where they appear. */
  alerts?: RegExp | null
}

/** Plain text with the viewer's alert words marked. */
function marked(text: string, alerts: RegExp | null | undefined, key: number): ReactNode[] {
  const ranges = alertRanges(alerts ?? null, text)
  if (!ranges.length) return [text]
  const out: ReactNode[] = []
  let at = 0
  ranges.forEach(([start, end], n) => {
    if (start > at) out.push(text.slice(at, start))
    out.push(<mark key={`a${key}-${n}`} className="alert-word">{text.slice(start, end)}</mark>)
    at = end
  })
  if (at < text.length) out.push(text.slice(at))
  return out
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/y
const MENTION_PATTERN = /<@([A-Za-z0-9_-]{43})>/y
const ROLE_MENTION_PATTERN = /<@&(\d{1,12})>/y
const ROLE_TOKEN = /<@&(\d{1,12})>/g
const EMOJI_PATTERN = new RegExp(CUSTOM_EMOJI_SOURCE, 'y')
const MASKED_SOURCE = '\\[([^\\]\\n]{1,200})\\]\\((https?:\\/\\/[^\\s<>"\')]+)\\)'
const MASKED_PATTERN = new RegExp(MASKED_SOURCE, 'y')
const TIMESTAMP_PATTERN = new RegExp(TIMESTAMP_SOURCE, 'y')

/** Message links ("…/#/open/<server>/c/<channel>/m/<id>") open right here instead of in a new tab. */
function openInApp(url: string): ((e: MouseEvent) => void) | undefined {
  const hash = url.slice(url.indexOf('#'))
  if (!url.includes('#/open/') || !parseOpenRoute(hash)) return undefined
  return (e) => {
    e.preventDefault()
    window.location.hash = hash
  }
}

/** Inline rules in priority order: the first one that matches at a position wins. */
const INLINE: { open: string; close: string; render: (children: ReactNode, key: number) => ReactNode; raw?: boolean; wordEdges?: boolean }[] = [
  { open: '`', close: '`', raw: true, render: (c, key) => <code key={key}>{c}</code> },
  { open: '||', close: '||', render: (c, key) => <Spoiler key={key}>{c}</Spoiler> },
  { open: '**', close: '**', render: (c, key) => <strong key={key}>{c}</strong> },
  { open: '~~', close: '~~', render: (c, key) => <s key={key}>{c}</s> },
  { open: '*', close: '*', render: (c, key) => <em key={key}>{c}</em> },
  { open: '_', close: '_', wordEdges: true, render: (c, key) => <em key={key}>{c}</em> },
]

function inline(text: string, ctx: MarkdownContext, depth = 0, links = true): ReactNode[] {
  const out: ReactNode[] = []
  let plain = ''
  let key = 0
  const flush = () => {
    if (plain) out.push(...marked(plain, ctx.alerts, key++))
    plain = ''
  }

  for (let i = 0; i < text.length; ) {
    // Escaped character: show it as-is.
    if (text[i] === '\\' && i + 1 < text.length && /[\\`*_~|<>]/.test(text[i + 1]) || (text[i] === '\\' && /[[\]#-]/.test(text[i + 1] ?? ''))) {
      plain += text[i + 1]
      i += 2
      continue
    }

    MASKED_PATTERN.lastIndex = i
    const masked = links ? MASKED_PATTERN.exec(text) : null
    if (masked) {
      flush()
      out.push(<MaskedLink key={key++} url={masked[2]}>{inline(masked[1], ctx, depth + 1, false)}</MaskedLink>)
      i += masked[0].length
      continue
    }

    TIMESTAMP_PATTERN.lastIndex = i
    const stamp = TIMESTAMP_PATTERN.exec(text)
    const ms = stamp ? parseTimestamp(stamp[1]) : null
    if (stamp && ms !== null) {
      flush()
      out.push(<Timestamp key={key++} ms={ms} style={(stamp[2] ?? 'f') as TimestampStyle} />)
      i += stamp[0].length
      continue
    }

    URL_PATTERN.lastIndex = i
    const url = links ? URL_PATTERN.exec(text) : null
    if (url) {
      flush()
      out.push(<a key={key++} href={url[0]} target="_blank" rel="noopener noreferrer" onClick={openInApp(url[0])}>{url[0]}</a>)
      i += url[0].length
      continue
    }

    MENTION_PATTERN.lastIndex = i
    const mention = MENTION_PATTERN.exec(text)
    if (mention) {
      flush()
      // Someone who replaced their account key is shown under their current key (a checked rotation, state/keyMap.ts).
      const who = resolveKey(mention[1])
      const name = ctx.nameOf(who)
      out.push(
        <span key={key++} className={`mention ${who === ctx.me ? 'me' : ''}`} {...userMenuProps(name ? who : null, ctx.serverKey ?? null)}>@{name ?? t('chat.markdown.unknown')}</span>,
      )
      i += mention[0].length
      continue
    }

    ROLE_MENTION_PATTERN.lastIndex = i
    const roleMention = ROLE_MENTION_PATTERN.exec(text)
    if (roleMention) {
      flush()
      const role = ctx.roleOf?.(Number(roleMention[1])) ?? null
      out.push(
        <span key={key++} className={`mention role-mention ${role?.mine ? 'me' : ''}`} style={role?.color ? { color: role.color } : undefined}>
          @{role?.name ?? t('chat.markdown.deletedRole')}
        </span>,
      )
      i += roleMention[0].length
      continue
    }

    EMOJI_PATTERN.lastIndex = i
    const emoji = EMOJI_PATTERN.exec(text)
    if (emoji) {
      flush()
      const url = ctx.emoji?.(emoji[2])
      out.push(
        url
          ? <img key={key++} className="custom-emoji" src={url} alt={`:${emoji[1]}:`} title={`:${emoji[1]}:`} draggable={false} />
          : <span key={key++} className="custom-emoji-missing">:{emoji[1]}:</span>,
      )
      i += emoji[0].length
      continue
    }

    const rule = depth < 6 ? INLINE.find((r) => text.startsWith(r.open, i)) : undefined
    if (rule) {
      const end = text.indexOf(rule.close, i + rule.open.length)
      // Needs content, and *word* style markers mustn't hug spaces ("2 * 3 * 4" isn't italic).
      const inner = end > i + rule.open.length ? text.slice(i + rule.open.length, end) : ''
      const word = /[\p{L}\p{N}]/u
      const atEdges = !rule.wordEdges || (!word.test(text[i - 1] ?? '') && !word.test(text[end + rule.close.length] ?? ''))
      const valid = inner.length > 0 && atEdges && (rule.raw || (!/^\s/.test(inner) && !/\s$/.test(inner)))
      if (valid) {
        flush()
        out.push(rule.render(rule.raw ? inner : inline(inner, ctx, depth + 1, links), key++))
        i = end + rule.close.length
        continue
      }
    }

    plain += text[i]
    i++
  }
  flush()
  return out
}

/** Inline formatting only (docs tables use it for cells). */
export const renderInline = (text: string, ctx: MarkdownContext): ReactNode[] => inline(text, ctx)

/** Renders a whole message: fenced code blocks and quotes, then inline formatting per line. */
export function renderMarkdown(text: string, ctx: MarkdownContext): ReactNode {
  const blocks: ReactNode[] = []
  const parts = text.split(/```/)
  parts.forEach((part, index) => {
    const isCode = index % 2 === 1 && index < parts.length - 1 // an unclosed fence is just text
    if (isCode) {
      const newline = part.indexOf('\n')
      const language = newline > 0 && /^[\w+-]{1,20}$/.test(part.slice(0, newline).trim()) ? part.slice(0, newline).trim() : ''
      const body = language ? part.slice(newline + 1) : part.replace(/^\n/, '')
      blocks.push(<CodeBlock key={`code${index}`} code={body.replace(/\n$/, '')} language={language} />)
      return
    }
    const source = index % 2 === 1 ? '```' + part : part
    const lines = source.split('\n')
    let quote: ReactNode[] = []
    const flushQuote = (k: string) => {
      if (quote.length) blocks.push(<blockquote key={k}>{quote}</blockquote>)
      quote = []
    }
    let list: { ordered: boolean; start: number; items: ReactNode[] } | null = null
    const flushList = (k: string) => {
      if (list) {
        blocks.push(list.ordered
          ? <ol key={k} className="md-list" start={list.start}>{list.items}</ol>
          : <ul key={k} className="md-list">{list.items}</ul>)
      }
      list = null
    }
    lines.forEach((line, n) => {
      const k = `${index}-${n}`
      const isQuote = /^> ?/.test(line)
      const content = isQuote ? line.replace(/^> ?/, '') : line
      const block = blockOf(content)
      if (block?.kind === 'item' && !isQuote) {
        flushQuote(`q${k}`)
        if (list && list.ordered !== block.ordered) flushList(`l${k}`)
        list ??= { ordered: block.ordered, start: block.start, items: [] }
        list.items.push(<li key={k} className={block.nested ? 'md-nested' : undefined}>{inline(block.text, ctx)}</li>)
        return
      }
      flushList(`l${k}`)
      const rendered = block?.kind === 'heading' ? (
        <div key={k} className={`md-heading md-h${block.level}`}>{inline(block.text, ctx)}</div>
      ) : block?.kind === 'subtext' ? (
        <div key={k} className="md-subtext">{inline(block.text, ctx)}</div>
      ) : (
        <Fragment key={k}>
          {inline(content, ctx)}
          {n < lines.length - 1 && '\n'}
        </Fragment>
      )
      if (isQuote) quote.push(rendered)
      else {
        flushQuote(`q${k}`)
        blocks.push(rendered)
      }
    })
    flushList(`l${index}-end`)
    flushQuote(`q${index}-end`)
  })
  return isEmojiOnly(text) ? <span className="jumbo">{blocks}</span> : <>{blocks}</>
}

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'subtext'; text: string }
  | { kind: 'item'; ordered: boolean; start: number; nested: boolean; text: string }

/** Line-level markdown: "# Heading", "-# small print", "- item", "1. item" (two leading spaces nest an item). */
function blockOf(line: string): Block | null {
  const heading = /^(#{1,3}) (\S.*)$/.exec(line)
  if (heading) return { kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] }
  const subtext = /^-# (\S.*)$/.exec(line)
  if (subtext) return { kind: 'subtext', text: subtext[1] }
  const item = /^( {2,})?([-*]|(\d{1,9})\.) (\S.*)$/.exec(line)
  if (item) return { kind: 'item', ordered: !!item[3], start: item[3] ? Number(item[3]) : 1, nested: !!item[1], text: item[4] }
  return null
}

/** Plain text of a message for previews and notifications (mentions become @names, markers stay). */
export function plainText(text: string, ctx: MarkdownContext): string {
  return text
    .replace(/<@([A-Za-z0-9_-]{43})>/g, (_, key: string) => `@${ctx.nameOf(resolveKey(key)) ?? t('chat.markdown.unknown')}`)
    .replace(ROLE_TOKEN, (_, id: string) => `@${ctx.roleOf?.(Number(id))?.name ?? t('chat.markdown.role')}`)
    .replace(new RegExp(CUSTOM_EMOJI_SOURCE, 'g'), (_, name: string) => `:${name}:`)
    .replace(new RegExp(TIMESTAMP_SOURCE, 'g'), (all: string, seconds: string, style?: string) => {
      const ms = parseTimestamp(seconds)
      return ms === null ? all : formatTimestamp(ms, (style ?? 'f') as TimestampStyle)
    })
    .replace(new RegExp(MASKED_SOURCE, 'g'), '$1')
}

/** Turns "@Name" into mention tokens for members (and roles) with that exact name (longest names first; members win a tie). */
export function encodeMentions(text: string, members: { accountKey: string; name: string }[], roles: { id: number; name: string }[] = []): string {
  const targets = [
    ...members.map((m) => ({ name: m.name, token: `<@${m.accountKey}>` })),
    ...roles.map((r) => ({ name: r.name, token: `<@&${r.id}>` })),
  ].sort((a, b) => b.name.length - a.name.length)
  let out = text
  for (const t of targets) {
    const escaped = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(^|[^\\w<])@${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), (_, before: string) => `${before}${t.token}`)
  }
  return out
}

/** The reverse, for editing a message: tokens back to "@Name". */
export function decodeMentions(text: string, nameOf: (accountKey: string) => string | null, roleName?: (id: number) => string | null): string {
  return text
    .replace(/<@([A-Za-z0-9_-]{43})>/g, (_, key: string) => `@${nameOf(resolveKey(key)) ?? t('chat.markdown.unknown')}`)
    .replace(ROLE_TOKEN, (token, id: string) => {
      const name = roleName?.(Number(id))
      return name ? `@${name}` : token
    })
}

/** Role ids mentioned in a message. */
export const roleMentions = (text: string): number[] => [...text.matchAll(ROLE_TOKEN)].map((m) => Number(m[1]))

/**
 * Does this message mention the viewer: directly, or with @everyone/@here when its author may ping
 * groups (see canPingGroups)? Otherwise the text still shows, it just doesn't notify.
 */
/** `here`: whether @here counts for you (not while you're invisible: you aren't "here" for anyone). */
export function mentions(text: string, me: string, groupPings = true, here = true): boolean {
  if (groupPings && (here ? /(^|\s)@(everyone|here)\b/ : /(^|\s)@everyone\b/).test(text)) return true
  for (const [, key] of text.matchAll(/<@([A-Za-z0-9_-]{43})>/g)) if (resolveKey(key) === me) return true
  return false
}

/**
 * The server's rule: only trusted and above ping @everyone/@here. Webhook posts may too: the server
 * already defuses those unless an admin allowed it for that webhook.
 */
export function canPingGroups(authorRole: Role | undefined, webhook: boolean): boolean {
  return webhook || (authorRole !== undefined && roleRank(authorRole) >= roleRank('trusted'))
}
