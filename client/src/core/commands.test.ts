import { describe, expect, it } from 'vitest'
import { parseCommand } from './commands'

describe('bot commands', () => {
  it('parses a command and its arguments', () => {
    expect(parseCommand('/roll 2d6')).toEqual({ name: 'roll', target: null, args: '2d6' })
    expect(parseCommand('  /Roll  ')).toEqual({ name: 'roll', target: null, args: '' })
    expect(parseCommand('/say hello\nworld')).toEqual({ name: 'say', target: null, args: 'hello\nworld' })
  })

  it('reads the bot a command is aimed at', () => {
    expect(parseCommand('/roll@Dice d20')).toEqual({ name: 'roll', target: 'Dice', args: 'd20' })
  })

  it('ignores ordinary messages', () => {
    expect(parseCommand('hello /roll')).toBeNull()
    expect(parseCommand('/')).toBeNull()
    expect(parseCommand('// comment')).toBeNull()
    expect(parseCommand('/' + 'x'.repeat(40))).toBeNull()
  })
})
