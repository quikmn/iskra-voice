import { describe, expect, it } from 'vitest'
import type { BotCommand } from '../../core/protocol'
import {
  activeOption, commandQueryAt, completeChoice, completeCommand, findCommand, matchChoices, matchCommands, signature, type CommandEntry,
} from './commandMatch'

const roll: BotCommand = {
  name: 'roll', description: 'Rolls dice',
  options: [
    { name: 'dice', description: 'Like 2d6', type: 'string', required: true, choices: [{ name: 'Twenty-sided', value: 'd20' }, { name: 'Two dice', value: '2d6' }] },
    { name: 'note', description: 'Why', type: 'string' },
  ],
}
const entries: CommandEntry[] = [
  { bot: 'k1', botName: 'Dice', command: roll },
  { bot: 'k1', botName: 'Dice', command: { name: 'coin', description: 'Flips a coin' } },
  { bot: 'k2', botName: 'Party Planner', command: { name: 'poll', description: 'Starts a poll', usage: 'question | a | b' } },
  { bot: 'k2', botName: 'Party Planner', command: { name: 'roll', description: 'Also rolls' } },
  { bot: 'k3', botName: 'Echo', command: { name: 'scroll', description: 'Scrolls' } },
]

describe('commandQueryAt', () => {
  it('finds the name being typed at the start', () => {
    expect(commandQueryAt('/', 1)).toEqual({ kind: 'name', query: '', target: null })
    expect(commandQueryAt('/Ro', 3)).toEqual({ kind: 'name', query: 'ro', target: null })
    expect(commandQueryAt('/roll@Di', 8)).toEqual({ kind: 'name', query: 'roll', target: 'Di' })
  })
  it('finds arguments after a space, at the end only', () => {
    expect(commandQueryAt('/roll 2d', 8)).toEqual({ kind: 'args', name: 'roll', target: null, args: '2d' })
    expect(commandQueryAt('/roll 2d', 3)).toBeNull()
  })
  it('ignores everything else', () => {
    expect(commandQueryAt('hi /roll', 8)).toBeNull()
    expect(commandQueryAt('/roll\nmore', 5)).toBeNull()
    expect(commandQueryAt('//', 2)).toBeNull()
    expect(commandQueryAt('', 0)).toBeNull()
  })
})

describe('matchCommands', () => {
  it('puts prefix matches first, then contains', () => {
    expect(matchCommands(entries, 'ro').map((e) => `${e.command.name}@${e.bot}`)).toEqual(['roll@k1', 'roll@k2', 'scroll@k3'])
    expect(matchCommands(entries, '').length).toBe(5)
    expect(matchCommands(entries, 'zzz')).toEqual([])
  })
  it('narrows to one bot after @, ignoring spaces in its name', () => {
    expect(matchCommands(entries, 'roll', 'party').map((e) => e.bot)).toEqual(['k2'])
  })
  it('limits the list', () => {
    expect(matchCommands(entries, '', null, 2).length).toBe(2)
  })
})

describe('completing', () => {
  it('adds the bot only when two bots share a name', () => {
    expect(completeCommand(entries[1], entries)).toBe('/coin ')
    expect(completeCommand(entries[0], entries)).toBe('/roll@Dice ')
    expect(completeCommand(entries[3], entries)).toBe('/roll@PartyPlanner ')
  })
  it('finds the command, by bot when targeted', () => {
    expect(findCommand(entries, 'roll', 'PartyPlanner')?.bot).toBe('k2')
    expect(findCommand(entries, 'roll', null)?.bot).toBe('k1')
    expect(findCommand(entries, 'nope', null)).toBeNull()
  })
})

describe('option hints', () => {
  it('shows a signature or the usage', () => {
    expect(signature(roll)).toBe('/roll <dice> [note]')
    expect(signature(entries[2].command)).toBe('/poll question | a | b')
  })
  it('tracks the option being typed; the last string takes the rest', () => {
    expect(activeOption(roll, '')).toMatchObject({ index: 0, word: '' })
    expect(activeOption(roll, '2d')).toMatchObject({ index: 0, word: '2d' })
    expect(activeOption(roll, '2d6 for the ')).toMatchObject({ index: 1, word: 'for the ' })
    expect(activeOption({ name: 'x', description: 'x', options: [{ name: 'n', description: 'n', type: 'integer' }] }, '1 2')).toBeNull()
    expect(activeOption(entries[1].command, '')).toBeNull()
  })
  it('matches and completes choices', () => {
    expect(matchChoices(roll.options![0], 'd').map((c) => c.value)).toEqual(['d20'])
    expect(matchChoices(roll.options![0], 'two').map((c) => c.value)).toEqual(['2d6'])
    expect(completeChoice('/roll tw', 'tw', '2d6')).toBe('/roll 2d6 ')
  })
})
