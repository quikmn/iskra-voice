// Bot commands: every bot's list (from welcome and `bot.commands`), and per channel which bots answer there
// (`bot.commands.available`, asked when "/" is typed and kept until something that could change it happens).
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { BotCommand, BotCommandList, Events } from '../core/protocol'
import type { CommandEntry } from '../ui/chat/commandMatch'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { t } from '../i18n'
import { localizeCommand } from './builtinBotsLogic'

interface BotCommandsState {
  /** serverKey → bot account key → its commands. */
  lists: Record<string, Record<string, BotCommand[]>>
  /** "serverKey:channelId" → bots that can read and post there. */
  available: Record<string, string[]>
}

export const useBotCommands = create<BotCommandsState>(() => ({ lists: {}, available: {} }))

const AVAILABLE_TTL_MS = 60_000
const fetchedAt = new Map<string, number>()
const inFlight = new Map<string, Promise<void>>()

function forget(serverKey: string): void {
  for (const key of [...fetchedAt.keys()]) if (key.startsWith(`${serverKey}:`)) fetchedAt.delete(key)
}

function setList(serverKey: string, list: BotCommandList): void {
  useBotCommands.setState((s) => {
    const lists = { ...(s.lists[serverKey] ?? {}) }
    if (list.commands.length > 0) lists[list.bot] = list.commands
    else delete lists[list.bot]
    return { lists: { ...s.lists, [serverKey]: lists } }
  })
}

onWelcomeHook((serverKey, welcome) => {
  const lists: Record<string, BotCommand[]> = {}
  for (const l of welcome.botCommands ?? []) if (l.commands.length > 0) lists[l.bot] = l.commands
  useBotCommands.setState((s) => ({ lists: { ...s.lists, [serverKey]: lists } }))
  forget(serverKey)
})

// Anything that can change who may post where makes the per-channel answers stale.
const STALE: ReadonlySet<string> = new Set(['channels', 'member.updated', 'member.joined', 'roles'])

onServerEvent((serverKey, type, body) => {
  if (type === 'bot.commands') {
    setList(serverKey, body as Events['bot.commands'])
    forget(serverKey)
  } else if (type === 'member.removed' || type === 'member.deleted') {
    setList(serverKey, { bot: (body as Events['member.removed']).accountKey, commands: [] })
    forget(serverKey)
  } else if (STALE.has(type)) {
    forget(serverKey)
  }
})

/** Asks the server which bots answer in this channel, unless we asked recently. */
export function loadAvailable(serverKey: string, channelId: number): Promise<void> {
  const key = `${serverKey}:${channelId}`
  if (Date.now() - (fetchedAt.get(key) ?? 0) < AVAILABLE_TTL_MS) return Promise.resolve()
  const running = inFlight.get(key)
  if (running) return running
  const connection = connectionFor(serverKey)
  if (!connection) return Promise.resolve()
  const request = connection.request('bot.commands.available', { channelId })
    .then(({ bots }) => {
      fetchedAt.set(key, Date.now())
      useBotCommands.setState((s) => ({ available: { ...s.available, [key]: bots } }))
    })
    .catch(() => undefined)
    .finally(() => inFlight.delete(key))
  inFlight.set(key, request)
  return request
}

const NONE: CommandEntry[] = []

/** The commands people can use in this channel (empty until the first "/", and in encrypted channels). */
export function useChannelCommands(serverKey: string, channelId: number, active: boolean, encrypted: boolean): CommandEntry[] {
  const lists = useBotCommands((s) => s.lists[serverKey])
  const bots = useBotCommands((s) => s.available[`${serverKey}:${channelId}`])
  const members = useApp((s) => s.servers[serverKey]?.members)
  const hasAny = !!lists && Object.keys(lists).length > 0

  useEffect(() => {
    if (active && hasAny && !encrypted) void loadAvailable(serverKey, channelId)
  }, [active, hasAny, encrypted, serverKey, channelId, lists])

  return useMemo(() => {
    if (encrypted || !lists || !bots) return NONE
    return bots.flatMap((bot) => {
      const member = members?.[bot]
      if (!member) return []
      // Built-in bots' hints in the app's language.
      return (lists[bot] ?? []).map((command) => ({ bot, botName: member.name, command: member.builtin ? localizeCommand(command, (key) => t(key as never)) : command }))
    })
  }, [encrypted, lists, bots, members])
}
