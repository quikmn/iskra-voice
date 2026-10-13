import { describe, expect, it } from 'vitest'
import type { BotCommand } from '../../core/protocol'
import { mayUse, parseOptions } from './commandInvoke'

const KEY = 'A'.repeat(43)
const lookup = {
  members: [{ accountKey: KEY, name: 'Viktor' }],
  channels: [{ id: 7, name: 'general' }],
  roles: [{ id: 3, name: 'Players' }],
}

const roll: BotCommand = {
  name: 'roll',
  description: 'Rolls dice',
  options: [
    { name: 'dice', description: 'Which', type: 'string', required: true, choices: [{ name: 'Twenty', value: 'd20' }, { name: 'Six', value: 'd6' }] },
    { name: 'times', description: 'How often', type: 'integer' },
    { name: 'secret', description: 'Only you', type: 'boolean' },
  ],
}

describe('typed commands become options', () => {
  it('reads one word per option, by type, with choices by value or name', () => {
    expect(parseOptions(roll, 'd20 3 yes', lookup)).toEqual({ ok: true, options: { dice: 'd20', times: 3, secret: true } })
    expect(parseOptions(roll, 'twenty', lookup)).toEqual({ ok: true, options: { dice: 'd20' } })
    expect(parseOptions(roll, 'D6 2 nej', lookup)).toEqual({ ok: true, options: { dice: 'd6', times: 2, secret: false } })
  })

  it('says which option is missing or wrong', () => {
    expect(parseOptions(roll, '', lookup)).toEqual({ ok: false, option: 'dice', reason: 'missing' })
    expect(parseOptions(roll, 'd8', lookup)).toEqual({ ok: false, option: 'dice', reason: 'invalid' })
    expect(parseOptions(roll, 'd6 1.5', lookup)).toEqual({ ok: false, option: 'times', reason: 'invalid' })
    expect(parseOptions(roll, 'd6 99999999999999999', lookup)).toEqual({ ok: false, option: 'times', reason: 'invalid' })
    expect(parseOptions(roll, 'd6 2 maybe', lookup)).toEqual({ ok: false, option: 'secret', reason: 'invalid' })
  })

  it('lets the last text option take the rest, and finds people, channels and roles', () => {
    const say: BotCommand = {
      name: 'say', description: 'Says',
      options: [
        { name: 'who', description: 'Who', type: 'user', required: true },
        { name: 'where', description: 'Where', type: 'channel', required: true },
        { name: 'team', description: 'Team', type: 'role', required: true },
        { name: 'bonus', description: 'Bonus', type: 'number', required: true },
        { name: 'text', description: 'What', type: 'string', required: true },
      ],
    }
    expect(parseOptions(say, `<@${KEY}> #general <@&3> 1,5 hello there  friends`, lookup))
      .toEqual({ ok: true, options: { who: KEY, where: 7, team: 3, bonus: 1.5, text: 'hello there friends' } })
    expect(parseOptions(say, 'viktor 7 @players -2 hi', lookup)).toEqual({ ok: true, options: { who: KEY, where: 7, team: 3, bonus: -2, text: 'hi' } })
    expect(parseOptions(say, 'nobody general players 1 hi', lookup)).toEqual({ ok: false, option: 'who', reason: 'invalid' })
    expect(parseOptions(say, 'viktor random players 1 hi', lookup)).toEqual({ ok: false, option: 'where', reason: 'invalid' })
  })

  it('takes no options when none are declared (the bot reads the text)', () => {
    expect(parseOptions({ name: 'pick', description: 'Picks' }, 'pizza, tacos', lookup)).toEqual({ ok: true, options: {} })
  })
})

describe('who may use a command', () => {
  const purge: BotCommand = { name: 'purge', description: 'Cleans', role: 'trusted', permission: 'manageMessages' }
  it('follows the role and the permission; admins have every permission', () => {
    expect(mayUse(roll, { role: 'guest' }, () => false)).toBe(true)
    expect(mayUse(purge, { role: 'member' }, () => true)).toBe(false)
    expect(mayUse(purge, { role: 'trusted' }, () => false)).toBe(false)
    expect(mayUse(purge, { role: 'trusted' }, (p) => p === 'manageMessages')).toBe(true)
    expect(mayUse(purge, { role: 'admin' }, () => false)).toBe(true)
    expect(mayUse(purge, null, () => true)).toBe(false)
  })
})
