// Chat formatting, Discord-style, rendered straight to React elements (never to an HTML string).
// Supported: ```code blocks```, `code`, **bold**, *italic* / _italic_, ~~strike~~, ||spoiler||,
// > quotes, links, and mentions written as <@accountKey> (shown as @name).
import { Fragment, type ReactNode } from 'react'
import { Spoiler } from './bits'

export interface MarkdownContext {
  /** Display name for a mentioned account, or null if unknown. */
  nameOf: (accountKey: string) => string | null
  /** The viewer's account, so mentions of them stand out. */
  me?: string
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/y
const MENTION_PATTERN = /<@([A-Za-z0-9_-]{43})>/y

/** Inline rules in priority order: the first one that matches at a position wins. */
const INLINE: { open: string; close: string; render: (children: ReactNode, key: number) => ReactNode; raw?: boolean; wordEdges?: boolean }[] = [
  { open: '`', close: '`', raw: true, render: (c, key) => <code key={key}>{c}</code> },
  { open: '||', close: '||', render: (c, key) => <Spoiler key={key}>{c}</Spoiler> },
  { open: '**', close: '**', render: (c, key) => <strong key={key}>{c}</strong> },
  { open: '~~', close: '~~', render: (c, key) => <s key={key}>{c}</s> },
  { open: '*', close: '*', render: (c, key) => <em key={key}>{c}</em> },
  { open: '_', close: '_', wordEdges: true, render: (c, key) => <em key={key}>{c}</em> },
]

function inline(text: string, ctx: MarkdownContext, depth = 0): ReactNode[] {
  const out: ReactNode[] = []
  let plain = ''
  let key = 0
  const flush = () => {
    if (plain) out.push(plain)
    plain = ''
  }

  for (let i = 0; i < text.length; ) {
    // Escaped character: show it as-is.
    if (text[i] === '\\' && i + 1 < text.length && /[\\`*_~|<>]/.test(text[i + 1])) {
      plain += text[i + 1]
      i += 2
      continue
    }

    URL_PATTERN.lastIndex = i
    const url = URL_PATTERN.exec(text)
    if (url) {
      flush()
      out.push(<a key={key++} href={url[0]} target="_blank" rel="noopener noreferrer">{url[0]}</a>)
      i += url[0].length
      continue
    }

    MENTION_PATTERN.lastIndex = i
    const mention = MENTION_PATTERN.exec(text)
    if (mention) {
      flush()
      const name = ctx.nameOf(mention[1])
      out.push(
        <span key={key++} className={`mention ${mention[1] === ctx.me ? 'me' : ''}`}>@{name ?? 'unknown'}</span>,
      )
      i += mention[0].length
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
        out.push(rule.render(rule.raw ? inner : inline(inner, ctx, depth + 1), key++))
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
      blocks.push(
        <pre key={`code${index}`} className="code-block" data-language={language || undefined}>
          <code>{body.replace(/\n$/, '')}</code>
        </pre>,
      )
      return
    }
    const source = index % 2 === 1 ? '```' + part : part
    const lines = source.split('\n')
    let quote: ReactNode[] = []
    const flushQuote = (k: string) => {
      if (quote.length) blocks.push(<blockquote key={k}>{quote}</blockquote>)
      quote = []
    }
    lines.forEach((line, n) => {
      const k = `${index}-${n}`
      const isQuote = /^> ?/.test(line)
      const content = isQuote ? line.replace(/^> ?/, '') : line
      const rendered = (
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
    flushQuote(`q${index}-end`)
  })
  return <>{blocks}</>
}

/** Plain text of a message for previews and notifications (mentions become @names, markers stay). */
export function plainText(text: string, ctx: MarkdownContext): string {
  return text.replace(/<@([A-Za-z0-9_-]{43})>/g, (_, key: string) => `@${ctx.nameOf(key) ?? 'unknown'}`)
}

/** Turns "@Name" into mention tokens for members with that exact name (longest names first). */
export function encodeMentions(text: string, members: { accountKey: string; name: string }[]): string {
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length)
  let out = text
  for (const m of sorted) {
    const escaped = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(^|[^\\w<])@${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), `$1<@${m.accountKey}>`)
  }
  return out
}

/** The reverse, for editing a message: tokens back to "@Name". */
export function decodeMentions(text: string, nameOf: (accountKey: string) => string | null): string {
  return text.replace(/<@([A-Za-z0-9_-]{43})>/g, (_, key: string) => `@${nameOf(key) ?? 'unknown'}`)
}

/** Does this message mention the viewer (directly or with @everyone)? */
export function mentions(text: string, me: string): boolean {
  return text.includes(`<@${me}>`) || /(^|\s)@everyone\b/.test(text)
}
