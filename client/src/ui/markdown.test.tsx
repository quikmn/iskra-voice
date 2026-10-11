import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { canPingGroups, decodeMentions, encodeMentions, mentions, plainText, renderMarkdown, roleMentions } from './markdown'

const alice = 'A'.repeat(43)
const ctx = { nameOf: (k: string) => (k === alice ? 'Alice' : null), me: alice }
const html = (text: string) => renderToStaticMarkup(<>{renderMarkdown(text, ctx)}</>)

describe('markdown', () => {
  it('formats the basics', () => {
    expect(html('**bold** *it* _it_ ~~gone~~ `x = 1`')).toBe(
      '<strong>bold</strong> <em>it</em> <em>it</em> <s>gone</s> <code>x = 1</code>',
    )
  })

  it('nests and leaves code alone', () => {
    expect(html('**bold _and italic_**')).toBe('<strong>bold <em>and italic</em></strong>')
    expect(html('`**not bold**`')).toBe('<code>**not bold**</code>')
  })

  it('does not italicise arithmetic or lone markers', () => {
    expect(html('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(html('snake_case_name')).toBe('snake_case_name') // underscores inside words aren't formatting
    expect(html('**')).toBe('**')
  })

  it('renders code blocks with a language and quotes', () => {
    const code = html('```js\nconst a = 1\n```')
    expect(code).toContain('<pre class="code-block" data-language="js"><code><span class="tok-keyword">const</span> a = <span class="tok-number">1</span></code></pre>')
    expect(code).toContain('aria-label="Copy code"')
    expect(html('```\n<b>raw</b>\n```')).toContain('<code>&lt;b&gt;raw&lt;/b&gt;</code>')
    expect(html('> quoted\nnormal')).toBe('<blockquote>quoted\n</blockquote>normal')
  })

  it('renders headings, subtext and lists', () => {
    expect(html('# Big\n## Medium\n### Small\n-# fine print')).toBe(
      '<div class="md-heading md-h1">Big</div><div class="md-heading md-h2">Medium</div><div class="md-heading md-h3">Small</div><div class="md-subtext">fine print</div>',
    )
    expect(html('- one\n- **two**\n  - nested\nafter')).toBe(
      '<ul class="md-list"><li>one</li><li><strong>two</strong></li><li class="md-nested">nested</li></ul>after',
    )
    expect(html('3. three\n4. four')).toBe('<ol class="md-list" start="3"><li>three</li><li>four</li></ol>')
    expect(html('#not a heading')).toBe('#not a heading')
    expect(html('\\# not a heading')).toBe('# not a heading')
    expect(html('2 - 1 = 1')).toBe('2 - 1 = 1')
  })

  it('masks links but asks before opening, and only for http(s)', () => {
    expect(html('[docs](https://iskra.foo/docs)')).toBe(
      '<a href="https://iskra.foo/docs" target="_blank" rel="noopener noreferrer" class="masked-link" title="https://iskra.foo/docs">docs</a>',
    )
    expect(html('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))')
    // A URL as the label can't sneak in a second link.
    expect(html('[https://bank.example](https://evil.example)')).toContain('>https://bank.example</a>')
    expect(html('[https://bank.example](https://evil.example)').match(/<a /g)).toHaveLength(1)
    expect(plainText('see [docs](https://iskra.foo)', ctx)).toBe('see docs')
  })

  it('shows timestamps in the reader’s time', () => {
    const out = html('meet <t:1760000000:R> or <t:1760000000:D>')
    expect(out).toContain('<time class="md-timestamp" dateTime="2025-10-09T08:53:20.000Z"')
    expect(html('<t:99999999999999999>')).toBe('&lt;t:99999999999999999&gt;')
  })

  it('never turns text into HTML', () => {
    const out = html('<img src=x onerror=alert(1)> **<script>x</script>**')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;img')
  })

  it('links only http(s) URLs', () => {
    expect(html('see https://iskra.foo/x.')).toBe('see <a href="https://iskra.foo/x" target="_blank" rel="noopener noreferrer">https://iskra.foo/x</a>.')
    expect(html('javascript:alert(1)')).toBe('javascript:alert(1)')
  })

  it('shows mentions by name and knows when you are mentioned', () => {
    expect(html(`hi <@${alice}>`)).toBe('hi <span class="mention me">@Alice</span>')
    expect(html(`hi <@${'B'.repeat(43)}>`)).toBe('hi <span class="mention ">@unknown</span>')
    expect(mentions(`hey <@${alice}>`, alice)).toBe(true)
    expect(mentions('@everyone game time', alice)).toBe(true)
    expect(mentions('no one', alice)).toBe(false)
    expect(mentions('@here quick question', alice)).toBe(true)
    // While you're invisible, @here isn't for you (@everyone still is).
    expect(mentions('@here quick question', alice, true, false)).toBe(false)
    expect(mentions('@everyone game time', alice, true, false)).toBe(true)
    // Group pings only count from trusted and above (or an allowed webhook), like on the server.
    expect(mentions('@everyone game time', alice, false)).toBe(false)
    expect(mentions(`@everyone and <@${alice}>`, alice, false)).toBe(true)
    expect(canPingGroups('member', false)).toBe(false)
    expect(canPingGroups(undefined, false)).toBe(false)
    expect(canPingGroups('trusted', false)).toBe(true)
    expect(canPingGroups('owner', false)).toBe(true)
    expect(canPingGroups(undefined, true)).toBe(true)
    expect(plainText(`hey <@${alice}>`, ctx)).toBe('hey @Alice')
  })

  it('supports escapes and spoilers', () => {
    expect(html('\\*not italic\\*')).toBe('*not italic*')
    expect(html('||secret||')).toContain('class="spoiler "')
  })

  it('encodes typed @names into mention tokens and back', () => {
    const bob = 'B'.repeat(43)
    const members = [{ accountKey: alice, name: 'Alice' }, { accountKey: bob, name: 'Alice Cooper' }]
    expect(encodeMentions('hey @Alice Cooper and @Alice!', members)).toBe(`hey <@${bob}> and <@${alice}>!`)
    expect(encodeMentions('mail me at x@Alice.com', members)).toBe('mail me at x@Alice.com')
    expect(encodeMentions('@Alicea is someone else', members)).toBe('@Alicea is someone else')
    expect(decodeMentions(`hi <@${alice}>`, (k) => (k === alice ? 'Alice' : null))).toBe('hi @Alice')
  })
})

describe('role mentions', () => {
  const key = 'A'.repeat(43)
  it('encodes @Role names (members win a tie) and decodes them back', () => {
    const roles = [{ id: 7, name: 'Moderators' }, { id: 8, name: 'Sam' }]
    const encoded = encodeMentions('hey @Moderators and @Sam', [{ accountKey: key, name: 'Sam' }], roles)
    expect(encoded).toBe(`hey <@&7> and <@${key}>`)
    expect(roleMentions(encoded)).toEqual([7])
    expect(decodeMentions(encoded, () => 'Sam', (id) => (id === 7 ? 'Moderators' : null))).toBe('hey @Moderators and @Sam')
    expect(plainText('<@&7> ping', { nameOf: () => null, roleOf: () => ({ name: 'Moderators', color: null, mine: false }) })).toBe('@Moderators ping')
  })
})
