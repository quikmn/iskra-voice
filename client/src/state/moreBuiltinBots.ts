// Starboard, Birthdays and Welcome: their settings (admins) and your own birthday on a server. Turning them on and
// off goes through builtinBots.ts like the other built-in bots.
import type { Birthday, BuiltinConfigs, MoreBuiltinBotId } from '../core/protocol'
import { connectionFor } from './store'

export async function getBotConfig<K extends MoreBuiltinBotId>(serverKey: string, bot: K): Promise<BuiltinConfigs[K] | null> {
  const connection = connectionFor(serverKey)
  if (!connection) return null
  const { config } = await connection.request('builtin.bots.config.get', { bot })
  return config as BuiltinConfigs[K]
}

export async function setBotConfig<K extends MoreBuiltinBotId>(serverKey: string, bot: K, patch: Partial<BuiltinConfigs[K]>): Promise<BuiltinConfigs[K] | null> {
  const connection = connectionFor(serverKey)
  if (!connection) return null
  const { config } = await connection.request('builtin.bots.config.set', { bot, ...patch })
  return config as BuiltinConfigs[K]
}

export async function getBirthday(serverKey: string): Promise<Birthday | null> {
  const connection = connectionFor(serverKey)
  if (!connection) return null
  return (await connection.request('birthday.get', {})).birthday
}

/** Saves your day and month on this server (null removes it). */
export async function setBirthday(serverKey: string, birthday: Birthday | null): Promise<Birthday | null> {
  const connection = connectionFor(serverKey)
  if (!connection) return null
  if (!birthday) {
    await connection.request('birthday.remove', {})
    return null
  }
  return (await connection.request('birthday.set', birthday)).birthday
}
