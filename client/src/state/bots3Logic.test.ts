import { describe, expect, it } from 'vitest'
import type { BuiltinReply, CountingConfig, ServerRole, SuggestionsConfig, Tag } from '../core/protocol'
import { localizeCommand } from './builtinBotsLogic'
import { BUILTIN_BOTS } from './builtinBotsLogic'
import { mergeMine } from './bots3'
import {
  applyVote, bots3Patch, filterTags, giveawayOpen, isBots3, isBots3Reply, nextVote, staffRoles, tagName, tagProblem, timeLeft,
} from './bots3Logic'

const t = (key: string) => key

describe('Tags, Suggestions, Giveaways and Counting', () => {
  it('are built-in bots with settings and localized commands', () => {
    expect(BUILTIN_BOTS.slice(-4)).toEqual(['tags', 'suggestions', 'giveaways', 'counting'])
    expect(['tags', 'suggestions', 'giveaways', 'counting'].every(isBots3)).toBe(true)
    expect(isBots3('starboard')).toBe(false)
    for (const name of ['tag', 'suggest', 'giveaway']) {
      expect(localizeCommand({ name, description: 'x', usage: 'y' }, t)).toEqual({
        name, description: `builtinBots.commands.${name}.description`, usage: `builtinBots.commands.${name}.usage`,
      })
    }
  })

  it('knows their answers apart from other built-in bots', () => {
    const reply = (kind: string) => ({ bot: 'tags', for: 'k', kind }) as unknown as BuiltinReply
    expect(isBots3Reply(reply('tag'))).toBe(true)
    expect(isBots3Reply(reply('suggestion'))).toBe(true)
    expect(isBots3Reply(reply('giveaway.won'))).toBe(true)
    expect(isBots3Reply(reply('counting.broken'))).toBe(true)
    expect(isBots3Reply(reply('star'))).toBe(false)
    expect(isBots3Reply(reply('roll'))).toBe(false)
  })

  it('checks tag names and texts like the server', () => {
    expect(tagName('  Rules ')).toBe('rules')
    expect(tagProblem('Rules', 'Be kind')).toBeNull()
    expect(tagProblem('faq-2', 'x')).toBeNull()
    expect(tagProblem('two words', 'x')).toBe('name')
    expect(tagProblem('ünicode', 'x')).toBe('name')
    expect(tagProblem('a'.repeat(33), 'x')).toBe('name')
    expect(tagProblem('list', 'x')).toBe('reserved')
    expect(tagProblem('ok', '   ')).toBe('text')
    expect(tagProblem('ok', 'a'.repeat(2001))).toBe('text')
  })

  it('finds tags by name first, then by text', () => {
    const tag = (name: string, text: string): Tag => ({ name, text, updatedBy: null, updatedAt: 0 })
    const tags = [tag('faq', 'pizza on fridays'), tag('pizza', 'the menu'), tag('rules', 'be kind')]
    expect(filterTags(tags, 'PIZZA').map((x) => x.name)).toEqual(['pizza', 'faq'])
    expect(filterTags(tags, ' ')).toBe(tags)
  })

  it('toggles and changes votes, keeping the counts right', () => {
    expect(nextVote(0, 1)).toBe(1)
    expect(nextVote(1, 1)).toBe(0)
    expect(nextVote(1, -1)).toBe(-1)
    expect(applyVote({ up: 3, down: 1 }, 1, -1)).toEqual({ up: 2, down: 2 })
    expect(applyVote({ up: 3, down: 1 }, 0, 1)).toEqual({ up: 4, down: 1 })
    expect(applyVote({ up: 0, down: 0 }, 1, 0)).toEqual({ up: 0, down: 0 }) // never below zero
  })

  it('folds in your own votes and entries for the cards asked about', () => {
    const before = { votes: { 1: 1 as const, 2: -1 as const }, entered: { 3: true }, staff: { suggestions: false, giveaways: false } }
    const after = mergeMine(before, [2, 3, 4], { votes: { 4: 1 }, entered: [], staff: { suggestions: true, giveaways: false } })
    expect(after.votes).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1 })
    expect(after.entered).toEqual({ 2: false, 3: false, 4: false })
    expect(after.staff.suggestions).toBe(true)
  })

  it('says whether a giveaway takes entries and how long is left', () => {
    expect(giveawayOpen({ status: 'open', endsAt: 2000 }, 1000)).toBe(true)
    expect(giveawayOpen({ status: 'open', endsAt: 1000 }, 1000)).toBe(false)
    expect(giveawayOpen({ status: 'cancelled', endsAt: 9000 }, 1000)).toBe(false)
    expect(timeLeft(1000 + 26 * 3_600_000 + 61_000, 1000)).toEqual({ days: 1, hours: 2, minutes: 2 })
    expect(timeLeft(1000, 2000)).toBeNull()
  })

  it('only offers roles members can not give themselves as staff', () => {
    const role = (id: number, selfAssign = false): ServerRole => ({ id, name: `r${id}`, color: null, icon: null, hoist: false, position: id, permissions: [], selfAssign })
    expect(staffRoles([role(1), role(2, true), role(3)]).map((r) => r.id)).toEqual([1, 3])
  })

  it('sends only what changed, never the read-only counts', () => {
    const saved: CountingConfig = { channelId: 1, math: false, current: 5, best: 9, bestAt: 1 }
    expect(bots3Patch<'counting'>(saved, { ...saved, math: true, current: 6, best: 10 })).toEqual({ math: true })
    const s: SuggestionsConfig = { channelId: 1, staffRoleId: null, anonymous: false }
    expect(bots3Patch<'suggestions'>(s, { ...s, staffRoleId: 4, anonymous: true })).toEqual({ staffRoleId: 4, anonymous: true })
    expect(bots3Patch<'suggestions'>(s, s)).toEqual({})
  })
})
