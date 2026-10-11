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
    expect(html('```js\nconst a = 1\n```')).toBe('<pre class="code-block" data-language="js"><code>const a = 1</code></pre>')
    expect(html('> quoted\nnormal')).toBe('<blockquote>quoted\n</blockquote>normal')
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
