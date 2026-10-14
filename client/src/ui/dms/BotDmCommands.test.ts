import { describe, expect, it } from 'vitest'
import type { BotCommand } from '../../core/protocol'
import { dmCommands } from './BotDmCommands'

describe('bot commands in DMs', () => {
  const commands: BotCommand[] = [
    { name: 'roll', description: 'Rolls dice' },
    { name: 'settings', description: 'Admins only', role: 'admin' },
    { name: 'purge', description: 'Needs a permission', permission: 'manageMessages' },
  ]

  it('lists what your role allows, and never commands that need a permission (the bot cannot check those in a DM)', () => {
    expect(dmCommands(commands, { role: 'member' }).map((c) => c.name)).toEqual(['roll'])
    expect(dmCommands(commands, { role: 'admin' }).map((c) => c.name)).toEqual(['roll', 'settings'])
    expect(dmCommands(undefined, { role: 'owner' })).toEqual([])
    expect(dmCommands(commands, null)).toEqual([])
  })
})
