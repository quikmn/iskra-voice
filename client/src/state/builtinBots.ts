// Built-in bots (Dice, Polls, Reminders): which are on per server (from welcome and `builtin.bots`), and turning them
// on or off (admins). While on, each is an ordinary bot member with `builtin` set; the server answers its commands.
import { create } from 'zustand'
import type { BuiltinBot, BuiltinBotId, Events } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook } from './store'

interface BuiltinBotsState {
  /** serverKey → the three built-in bots (empty for servers that don't have them). */
  bots: Record<string, BuiltinBot[]>
}

export const useBuiltinBots = create<BuiltinBotsState>(() => ({ bots: {} }))

const set = (serverKey: string, bots: BuiltinBot[]) => useBuiltinBots.setState((s) => ({ bots: { ...s.bots, [serverKey]: bots } }))

onWelcomeHook((serverKey, welcome) => set(serverKey, welcome.builtinBots ?? []))
onServerEvent((serverKey, type, body) => {
  if (type === 'builtin.bots') set(serverKey, (body as Events['builtin.bots']).bots)
})

/** Turns a built-in bot on or off (admins only; the server says no to anyone else). */
export async function setBuiltinBot(serverKey: string, bot: BuiltinBotId, enabled: boolean): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) return
  const { bots } = await connection.request('builtin.bots.set', { bot, enabled })
  set(serverKey, bots)
}

