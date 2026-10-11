import { describe, expect, it } from 'vitest'
import type { ServerRules } from '../core/protocol'
import { clampLimit, hasRules, isFull, limitLabel, rulesProblem, rulesUpdate, shouldAutoOpen } from './voiceRulesLogic'

const rules = (patch: Partial<ServerRules> = {}): ServerRules => ({
  text: 'Be kind.', welcome: '', required: true, version: 2, updatedAt: 1, mustAgree: true, agreedVersion: 1, ...patch,
})

describe('voice user limits', () => {
  it('labels channels with a limit like Discord', () => {
    expect(limitLabel(2, 5)).toBe('2/5')
    expect(limitLabel(0, 1)).toBe('0/1')
    expect(limitLabel(3, 0)).toBeNull()
    expect(limitLabel(3, undefined)).toBeNull()
  })

  it('is full at the limit unless you can move members', () => {
    expect(isFull(5, 5, false)).toBe(true)
    expect(isFull(6, 5, false)).toBe(true)
    expect(isFull(4, 5, false)).toBe(false)
    expect(isFull(5, 5, true)).toBe(false)
    expect(isFull(50, 0, false)).toBe(false)
  })

  it('clamps typed limits to 0–99', () => {
    expect(clampLimit(-3)).toBe(0)
    expect(clampLimit(150)).toBe(99)
    expect(clampLimit(4.6)).toBe(5)
    expect(clampLimit(Number.NaN)).toBe(0)
  })
})

describe('server rules', () => {
  it('opens the welcome screen once per version until agreed', () => {
    expect(shouldAutoOpen(rules(), undefined)).toBe(true)
    expect(shouldAutoOpen(rules(), 2)).toBe(false) // closed it for this version
    expect(shouldAutoOpen(rules(), 1)).toBe(true) // asked again since
    expect(shouldAutoOpen(rules({ mustAgree: false }), undefined)).toBe(false)
    expect(shouldAutoOpen(undefined, undefined)).toBe(false)
  })

  it('knows whether there are rules to show', () => {
    expect(hasRules(rules())).toBe(true)
    expect(hasRules(rules({ text: '  ' }))).toBe(false)
    expect(hasRules(undefined)).toBe(false)
  })

  it('asks who must agree when turning it on, and whether to ask again when it is on', () => {
    const draft = { text: ' Be kind. ', welcome: ' Hi ', required: true, askEveryone: true }
    const on = rulesUpdate(rules({ required: false }), draft)
    expect(on.question).toBe('existing')
    expect(on.body).toEqual({ text: 'Be kind.', welcome: 'Hi', required: true, reaccept: true })
    expect(rulesUpdate(undefined, { ...draft, askEveryone: false }).body.reaccept).toBe(false)

    expect(rulesUpdate(rules(), draft).question).toBe('again')
    const off = rulesUpdate(rules(), { ...draft, required: false })
    expect(off.question).toBeNull()
    expect(off.body.reaccept).toBe(false)
  })

  it('refuses drafts the server would refuse', () => {
    expect(rulesProblem({ text: '', welcome: '', required: true, askEveryone: false })).toMatch(/Write the rules/)
    expect(rulesProblem({ text: 'x'.repeat(6001), welcome: '', required: false, askEveryone: false })).toMatch(/6000/)
    expect(rulesProblem({ text: 'ok', welcome: 'x'.repeat(501), required: false, askEveryone: false })).toMatch(/500/)
    expect(rulesProblem({ text: '', welcome: '', required: false, askEveryone: false })).toBeNull()
  })
})
