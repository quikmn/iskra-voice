import { describe, expect, it } from 'vitest'
import { activeRules, defaultAutoMod, isAutoModError, parseDomains, parseList, suggestedAutoMod, wordListProblem } from './automod'

describe('automod settings', () => {
  it('starts with everything off', () => {
    const c = defaultAutoMod()
    expect(c.enabled).toBe(false)
    expect(activeRules(c)).toEqual([])
  })

  it('suggests spam rules, with timeouts only for people who may give them', () => {
    const withTimeouts = suggestedAutoMod(defaultAutoMod(), true, 7)
    expect(withTimeouts.enabled).toBe(true)
    expect(activeRules(withTimeouts)).toEqual(['mentions', 'flood', 'duplicates', 'links'])
    expect(withTimeouts.mentions.action).toEqual({ timeoutMs: 300_000, alert: true })
    expect(withTimeouts.alertChannelId).toBe(7)
    const without = suggestedAutoMod(defaultAutoMod(), false, null)
    expect(without.flood.action).toEqual({ timeoutMs: 0, alert: false })
    // Words stay as they were, and are switched on when there are some.
    const words = suggestedAutoMod({ ...defaultAutoMod(), words: { ...defaultAutoMod().words, blocked: ['bad'] } }, true, null)
    expect(words.words.enabled).toBe(true)
    expect(words.words.blocked).toEqual(['bad'])
  })

  it('reads word lists one per line', () => {
    expect(parseList('bad\n  Bad \n\nworse, bad*\n')).toEqual(['bad', 'worse', 'bad*'])
  })

  it('explains bad word lists', () => {
    expect(wordListProblem(['ok', 'b*d'], 500)).toBeNull()
    expect(wordListProblem(['***'], 500)).toMatch(/letter or digit/)
    expect(wordListProblem(['x'.repeat(51)], 500)).toMatch(/50 characters/)
    expect(wordListProblem(['a*b*c*d*e*'], 500)).toMatch(/more than 4/)
    expect(wordListProblem(['a', 'b', 'c'], 2)).toMatch(/Up to 2/)
  })

  it('tidies domains', () => {
    expect(parseDomains('https://www.YouTube.com/\n*.example.org')).toEqual({ domains: ['youtube.com', 'example.org'], bad: null })
    expect(parseDomains('not a domain').bad).toBe('not a domain')
  })

  it('recognises AutoMod refusals', () => {
    expect(isAutoModError({ code: 'automod' })).toBe(true)
    expect(isAutoModError(new Error('x'))).toBe(false)
    expect(isAutoModError(null)).toBe(false)
  })
})
