// DMs with bots: whether this account takes DMs from bots (kept on the device and handed to every server you're on, the
// newest choice wins, like the block list), and what the app needs to know about a bot it's talking to.
import { create } from 'zustand'
import type { BotDmSetting, Events, Member } from '../core/protocol'
import * as storage from '../core/storage'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

/** Default: allowed (`at` 0 means never chosen). */
export const useBotDms = create<BotDmSetting>(() => ({ allow: true, at: 0 }))

let loaded: Promise<void> | null = null
function ensureLoaded(): Promise<void> {
  loaded ??= storage.loadBotDms()
    .then((stored) => {
      if (stored && stored.at > useBotDms.getState().at) useBotDms.setState({ allow: stored.allow, at: stored.at })
    })
    .catch(() => undefined)
  return loaded
}

const online = () => Object.keys(useApp.getState().servers).filter((key) => connectionFor(key)?.isOnline)

/** Takes a newer setting (from this device or a server), saves it and hands it to the other servers. */
async function adopt(next: BotDmSetting, from?: string): Promise<void> {
  if (next.at <= useBotDms.getState().at) return
  useBotDms.setState({ allow: next.allow, at: next.at })
  await storage.saveBotDms({ allow: next.allow, at: next.at }).catch(() => undefined)
  for (const key of online()) if (key !== from) void push(key)
}

async function push(serverKey: string): Promise<void> {
  const setting = useBotDms.getState()
  const connection = connectionFor(serverKey)
  if (setting.at === 0 || !connection?.isOnline) return
  try {
    await adopt(await connection.request('dm.bots.set', { allow: setting.allow, at: setting.at }), serverKey)
  } catch {
    /* an older server, or offline again: retried on the next connect */
  }
}

async function syncServer(serverKey: string): Promise<void> {
  await ensureLoaded()
  const connection = connectionFor(serverKey)
  if (!connection?.isOnline) return
  try {
    const remote = await connection.request('dm.bots.get', {})
    if (remote.at > useBotDms.getState().at) await adopt(remote, serverKey)
    else if (remote.at < useBotDms.getState().at) await push(serverKey)
  } catch {
    /* an older server */
  }
}

/** Turns DMs from bots on or off, on every server. */
export async function setBotDms(allow: boolean): Promise<void> {
  await ensureLoaded()
  await adopt({ allow, at: Math.max(Date.now(), useBotDms.getState().at + 1) })
}

onWelcomeHook((serverKey) => void syncServer(serverKey))
onServerEvent((serverKey, type, body) => {
  if (type === 'dm.bots') void adopt(body as Events['dm.bots'], serverKey)
})

// ── Who is a bot ────────────────────────────────────────────────────────────

/** A bot account as any of your servers knows it (null for people and unknown accounts). */
export function botMember(accountKey: string): Member | null {
  for (const server of Object.values(useApp.getState().servers)) {
    const member = server.members[accountKey]
    if (member?.bot) return member
  }
  return null
}

/** For the DM view: whether the person is a bot, and whether it's a built-in one (those take no DMs). */
export function useBotPeer(accountKey: string): { bot: boolean; builtin: boolean } {
  const bot = useApp((s) => Object.values(s.servers).some((server) => !!server.members[accountKey]?.bot))
  const builtin = useApp((s) => Object.values(s.servers).some((server) => !!server.members[accountKey]?.builtin))
  return { bot, builtin }
}
