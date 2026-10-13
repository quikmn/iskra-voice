import { describe, expect, it } from 'vitest'
import type { BuiltinReply } from '../core/protocol'
import { botReminderAbout, localizeCommand, replyLine, rollTerms } from './builtinBotsLogic'

const t = (key: string, args?: Record<string, unknown>) => `${key}${args ? ` ${JSON.stringify(args)}` : ''}`
const b64u = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('built-in bots', () => {
  it('words built-in commands in the app language and leaves other bots alone', () => {
    expect(localizeCommand({ name: 'roll', description: 'Rolls dice, like 2d6+3', usage: '2d6+3' }, t))
      .toEqual({ name: 'roll', description: 'builtinBots.commands.roll.description', usage: 'builtinBots.commands.roll.usage' })
    const other = { name: 'coin', description: 'Flips a coin' }
    expect(localizeCommand(other, t)).toBe(other)
  })

  it('shows a roll as dice groups, marking the lowest and highest faces, then the modifier', () => {
    const reply: Extract<BuiltinReply, { kind: 'roll' }> = {
      bot: 'dice', for: 'k', kind: 'roll', expression: '2d6-1d4-2', modifier: -2, total: 4,
      groups: [{ sign: 1, count: 2, sides: 6, rolls: [6, 1] }, { sign: -1, count: 1, sides: 4, rolls: [3] }],
    }
    expect(rollTerms(reply)).toEqual([
      { op: null, label: '2d6', dice: [{ value: 6, edge: 'max' }, { value: 1, edge: 'min' }] },
      { op: '-', label: '1d4', dice: [{ value: 3, edge: null }] },
      { op: '-', label: '2', dice: null },
    ])
    expect(rollTerms({ ...reply, modifier: 0 })).toHaveLength(2)
  })

  it('words every kind of answer, with the asker and a local time', () => {
    const when = (ms: number) => `@${ms}`
    const error = (e: unknown) => (e as { message: string }).message
    const base = { bot: 'dice' as const, for: 'k' }
    expect(replyLine({ ...base, kind: 'roll.invalid', input: 'banana' }, 'Alice', t, when, error))
      .toBe('builtinBots.reply.rollInvalid {"name":"Alice","input":"banana"}')
    expect(replyLine({ ...base, bot: 'reminders', kind: 'remind', dueAt: 5 }, 'Alice', t, when, error))
      .toBe('builtinBots.reply.remind {"name":"Alice","when":"@5"}')
    expect(replyLine({ ...base, bot: 'polls', kind: 'poll.usage' }, 'Alice', t, when, error)).toBe('builtinBots.reply.pollUsage {"name":"Alice"}')
    expect(replyLine({ ...base, bot: 'reminders', kind: 'remind.usage' }, 'Alice', t, when, error)).toBe('builtinBots.reply.remindUsage {"name":"Alice"}')
    expect(replyLine({ ...base, bot: 'polls', kind: 'error', error: { code: 'bad_request', message: 'Nope' } }, 'Alice', t, when, error))
      .toBe('builtinBots.reply.error {"name":"Alice","message":"Nope"}')
  })

  it('reads reminder data from the Reminders bot, and nothing else', () => {
    expect(botReminderAbout(`bot.${b64u(JSON.stringify({ note: 'take the pizza out 🍕', where: '#general', at: 1700 }))}`))
      .toEqual({ note: 'take the pizza out 🍕', where: '#general', at: 1700 })
    expect(botReminderAbout(b64u(JSON.stringify({ note: 'x', where: '#a', at: 1 })))).toBeNull()
    expect(botReminderAbout('bot.not-json')).toBeNull()
    expect(botReminderAbout(`bot.${b64u(JSON.stringify({ note: 'x', where: '#a', at: -1 }))}`)).toBeNull()
    expect(botReminderAbout(`bot.${b64u(JSON.stringify({ at: 2 }))}`)).toEqual({ note: '', where: '', at: 2 })
  })
})
