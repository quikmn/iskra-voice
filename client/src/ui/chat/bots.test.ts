import { describe, expect, it } from 'vitest'
import type { Member } from '../../core/protocol'
import { authorOf, embedColor, safeUrl, sameSender } from './bots'

const members: Record<string, Member> = {
  alice: { accountKey: 'alice', name: 'Alice', role: 'member', online: true },
  dice: { accountKey: 'dice', name: 'Dice', role: 'member', online: true, bot: true },
}
const hook = { id: 'h1', name: 'CI', avatar: null, embeds: [] }

describe('bot and webhook messages', () => {
  it('names the author: webhook, bot, member or former member', () => {
    expect(authorOf({ author: 'webhook:h1', webhook: hook }, members)).toEqual({ name: 'CI', bot: true, avatar: null })
    expect(authorOf({ author: 'dice', webhook: null }, members)).toMatchObject({ name: 'Dice', bot: true })
    expect(authorOf({ author: 'alice' }, members)).toMatchObject({ name: 'Alice', bot: false })
    expect(authorOf({ author: 'gone' }, members)).toMatchObject({ name: 'Former member', bot: false })
  })

  it('groups webhook posts only under the same name', () => {
    expect(sameSender({ author: 'webhook:h1', webhook: hook }, { author: 'webhook:h1', webhook: hook })).toBe(true)
    expect(sameSender({ author: 'webhook:h1', webhook: hook }, { author: 'webhook:h1', webhook: { ...hook, name: 'Deploy' } })).toBe(false)
    expect(sameSender({ author: 'alice' }, { author: 'alice', webhook: null })).toBe(true)
  })

  it('turns embed colours into CSS', () => {
    expect(embedColor(0xff0000)).toBe('#ff0000')
    expect(embedColor(255)).toBe('#0000ff')
    expect(embedColor(undefined)).toBeNull()
    expect(embedColor(-1)).toBeNull()
    expect(embedColor(0x1000000)).toBeNull()
  })

  it('only links to http(s)', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('data:text/html,hi')).toBeNull()
    expect(safeUrl('not a url')).toBeNull()
  })
})
