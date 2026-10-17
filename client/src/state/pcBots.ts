// Bots on this PC (desktop app only): which servers can give a bot invite, making one, and how a bot's state reads.
// The desktop app runs the bots (desktop/src/bots.ts); the server still decides everything a bot may do.
import { buildInviteLink } from '../core/invite'
import { roleRank } from '../core/protocol'
import type { PcBot } from '../platform/desktop'
import { connectionFor, type ServerState } from './store'

/** Servers where you can make a bot invite (admins and the owner), connected right now, by name. */
export function inviteServers(servers: Record<string, ServerState>): ServerState[] {
  return Object.values(servers)
    .filter((s) => s.me && roleRank(s.me.role) >= roleRank('admin') && s.status.state === 'online')
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A single-use bot invite (role member) on a server where you're an admin, as a link the bot can use. `readAll` and
 * `voice` as the gallery bot needs them; the server checks your rights (bot.invite is admin+).
 */
export async function createBotInvite(server: ServerState, needs: { readAll: boolean; voice: boolean }, appUrl = 'https://app.iskra.foo/'): Promise<string> {
  const connection = connectionFor(server.key)
  if (!connection) throw new Error('offline')
  const { invite } = await connection.request('bot.invite', { role: 'member', readAll: needs.readAll, voice: needs.voice })
  return buildInviteLink(server.appUrl ?? appUrl, { serverUrl: server.directUrl, serverKey: server.key, code: invite.code })
}

/** Bot invite links as the app makes them (the desktop app checks again). */
export const looksLikeBotInvite = (text: string): boolean => /^(https?|iskra):\/\/\S+#\/join\/\S+$/.test(text.trim())

export type BotLight = 'online' | 'starting' | 'offline' | 'stopped' | 'failed'

/** One word for a bot's state: running and connected, starting (or reconnecting), stopped, or ended with a problem. */
export function botLight(bot: PcBot): BotLight {
  if (bot.state === 'failed') return 'failed'
  if (bot.state === 'stopped') return 'stopped'
  if (bot.online) return 'online'
  return bot.state === 'running' ? 'offline' : 'starting'
}

/** The i18n key (under pcBots.problem) for why a bot ended, with its exit code. */
export function problemKey(problem: string | null): { key: 'noEntry' | 'noPython' | 'spawn' | 'notTrusted' | 'exit'; code?: string } | null {
  if (!problem) return null
  if (problem === 'not-trusted') return { key: 'notTrusted' }
  if (problem === 'no-entry') return { key: 'noEntry' }
  if (problem === 'no-python') return { key: 'noPython' }
  if (problem === 'spawn') return { key: 'spawn' }
  return { key: 'exit', code: problem }
}
