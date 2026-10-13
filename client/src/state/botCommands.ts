// Bot commands: every bot's list (from welcome and `bot.commands`), and per channel which bots answer there
// (`bot.commands.available`, asked when "/" is typed and kept until something that could change it happens).
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { BotCommand, BotCommandList, Events } from '../core/protocol'
import type { CommandEntry } from '../ui/chat/commandMatch'
import { mayUse } from '../ui/chat/commandInvoke'
import { has } from './permissions'
import { useServerRoles } from './roles'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { t } from '../i18n'
import { localizeCommand } from './builtinBotsLogic'

interface BotCommandsState {
  /** serverKey → bot account key → its commands. */
  lists: Record<string, Record<string, BotCommand[]>>
  /** serverKey → bot account key → it takes commands as interactions. */
  interactive: Record<string, Record<string, boolean>>
  /** "serverKey:channelId" → bots that can read and post there. */
  available: Record<string, string[]>
}

export const useBotCommands = create<BotCommandsState>(() => ({ lists: {}, interactive: {}, available: {} }))

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
    const interactive = { ...(s.interactive[serverKey] ?? {}), [list.bot]: !!list.interactions }
    return { lists: { ...s.lists, [serverKey]: lists }, interactive: { ...s.interactive, [serverKey]: interactive } }
  })
}

onWelcomeHook((serverKey, welcome) => {
  const lists: Record<string, BotCommand[]> = {}
  const interactive: Record<string, boolean> = {}
  for (const l of welcome.botCommands ?? []) {
    if (l.commands.length > 0) lists[l.bot] = l.commands
    interactive[l.bot] = !!l.interactions
  }
  useBotCommands.setState((s) => ({ lists: { ...s.lists, [serverKey]: lists }, interactive: { ...s.interactive, [serverKey]: interactive } }))
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

/**
 * The commands this person can use in this channel (empty until the first "/"). In encrypted channels only bots that
 * take interactions are listed (the server says which); their answers are private there.
 */
export function useChannelCommands(serverKey: string, channelId: number, active: boolean, encrypted: boolean): CommandEntry[] {
  const lists = useBotCommands((s) => s.lists[serverKey])
  const interactive = useBotCommands((s) => s.interactive[serverKey])
  const bots = useBotCommands((s) => s.available[`${serverKey}:${channelId}`])
  const members = useApp((s) => s.servers[serverKey]?.members)
  const me = useApp((s) => s.servers[serverKey]?.me)
  const roles = useServerRoles(serverKey)
  const hasAny = !!lists && Object.keys(lists).length > 0

  useEffect(() => {
    if (active && hasAny) void loadAvailable(serverKey, channelId)
  }, [active, hasAny, serverKey, channelId, lists])

  return useMemo(() => {
    if (!lists || !bots) return NONE
    const allowed = (command: BotCommand) => mayUse(command, me, (p) => has(me, roles, p as Parameters<typeof has>[2]))
    return bots.flatMap((bot) => {
      const member = members?.[bot]
      const takes = !!interactive?.[bot]
      if (!member || (encrypted && !takes)) return []
      // Built-in bots' hints in the app's language.
      return (lists[bot] ?? []).filter(allowed).map((command) => ({
        bot, botName: member.name, command: member.builtin ? localizeCommand(command, (key) => t(key as never)) : command, interactions: takes,
      }))
    })
  }, [encrypted, lists, interactive, bots, members, me, roles])
}

/**
 * A command of a bot that takes interactions, by name (and "@Bot"), even before this channel's list has loaded: typing
 * "/roll 2d6" and Enter quickly must not post the text. The server checks the channel and the bot.
 */
export function interactiveCommand(serverKey: string, name: string, target: string | null, botName: (key: string) => string | undefined): CommandEntry | null {
  const { lists, interactive } = useBotCommands.getState()
  for (const [bot, commands] of Object.entries(lists[serverKey] ?? {})) {
    const command = commands.find((c) => c.name === name)
    const shown = botName(bot)
    if (!command || !interactive[serverKey]?.[bot] || !shown) continue
    if (target && shown.replace(/\s+/gu, '').toLowerCase() !== target.toLowerCase()) continue
    return { bot, botName: shown, command, interactions: true }
  }
  return null
}
