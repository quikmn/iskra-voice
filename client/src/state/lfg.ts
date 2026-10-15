// Looking for group: posts live on their messages (`lfg`), kept current by lfg.updated; joins, the "group is full"
// ping with a Join voice button, and the per-server "Notify me for LFG" opt-in. The server decides who may join.
import { create } from 'zustand'
import type { Events, Lfg, LfgCreate } from '../core/protocol'
import { t } from '../i18n'
import { jumpToMessage } from './jump'
import { show } from './notify'
import { channelConv, isOnScreen } from './readState'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'

export interface LfgNotice {
  kind: 'joined' | 'full' | 'posted'
  serverKey: string
  channelId: number
  id: number
  game: string
  /** Who joined (joined) or posted (posted). */
  accountKey: string | null
  voiceChannelId: number | null
  at: number
}

interface LfgState {
  /** "Notify me for LFG", per server (missing until lfg.notify.get answers). */
  notify: Record<string, boolean>
  /** The create dialog: which text channel it posts in, and what to start with. */
  composing: { serverKey: string; channelId: number; game: string; slots: number | null } | null
  notices: LfgNotice[]
}

export const useLfg = create<LfgState>(() => ({ notify: {}, composing: null, notices: [] }))

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error('not connected')
  return c
}

export const openLfg = (serverKey: string, channelId: number, game = '', slots: number | null = null) =>
  useLfg.setState({ composing: { serverKey, channelId, game, slots } })
export const closeLfg = () => useLfg.setState({ composing: null })

export async function createLfg(serverKey: string, post: LfgCreate): Promise<void> {
  await connection(serverKey).request('lfg.create', post)
}

export async function joinLfg(serverKey: string, id: number): Promise<void> {
  const { lfg } = await connection(serverKey).request('lfg.join', { id })
  patchLfg(serverKey, id, lfg)
}

export async function leaveLfg(serverKey: string, id: number): Promise<void> {
  const { lfg } = await connection(serverKey).request('lfg.leave', { id })
  patchLfg(serverKey, id, lfg)
}

export async function closeLfgPost(serverKey: string, id: number): Promise<void> {
  await connection(serverKey).request('lfg.close', { id })
}

export async function setLfgNotify(serverKey: string, on: boolean): Promise<void> {
  const result = await connection(serverKey).request('lfg.notify.set', { on })
  useLfg.setState((s) => ({ notify: { ...s.notify, [serverKey]: result.on } }))
}

export function dismissLfgNotice(at: number): void {
  useLfg.setState((s) => ({ notices: s.notices.filter((n) => n.at !== at) }))
}

/** Puts the post's new state on its message, wherever that message is loaded. */
function patchLfg(serverKey: string, id: number, lfg: Lfg, channelId?: number): void {
  useApp.setState((state) => {
    const server = state.servers[serverKey]
    if (!server) return state
    const channels = channelId !== undefined ? [channelId] : Object.keys(server.messages).map(Number)
    let messages = server.messages
    for (const ch of channels) {
      const list = messages[ch]
      if (!list?.some((m) => m.id === id && !m.tempId)) continue
      messages = { ...messages, [ch]: list.map((m) => (m.id === id && !m.tempId ? { ...m, lfg } : m)) }
    }
    return messages === server.messages ? state : { servers: { ...state.servers, [serverKey]: { ...server, messages } } }
  })
}

function notice(n: Omit<LfgNotice, 'at'>): void {
  useLfg.setState((s) => ({ notices: [...s.notices.slice(-2), { ...n, at: Date.now() }] }))
}

export const openPost = (serverKey: string, channelId: number, id: number) => () => void jumpToMessage(serverKey, channelId, id)

onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('lfg.notify.get', {})
    .then(({ on }) => useLfg.setState((s) => ({ notify: { ...s.notify, [serverKey]: on } })))
    .catch(() => undefined) // an older server: no LFG
})

onServerEvent((serverKey, type, body) => {
  const server = useApp.getState().servers[serverKey]
  const name = (key: string) => server?.members[key]?.name ?? t('common.someone')
  switch (type) {
    case 'lfg.updated': {
      const { id, channelId, lfg } = body as Events['lfg.updated']
      patchLfg(serverKey, id, lfg, channelId)
      return
    }
    case 'lfg.joined': {
      const { id, channelId, accountKey, lfg } = body as Events['lfg.joined']
      patchLfg(serverKey, id, lfg, channelId)
      notice({ kind: 'joined', serverKey, channelId, id, game: lfg.game, accountKey, voiceChannelId: lfg.voiceChannelId })
      show(serverKey, t('lfg.notify.joinedTitle', { name: name(accountKey), game: lfg.game }),
        t('lfg.notify.slots', { count: lfg.joined.length, slots: lfg.slots }), openPost(serverKey, channelId, id))
      return
    }
    case 'lfg.full': {
      const { id, channelId, lfg } = body as Events['lfg.full']
      patchLfg(serverKey, id, lfg, channelId)
      notice({ kind: 'full', serverKey, channelId, id, game: lfg.game, accountKey: null, voiceChannelId: lfg.voiceChannelId })
      show(serverKey, t('lfg.notify.fullTitle', { game: lfg.game }), t('lfg.notify.fullBody'), openPost(serverKey, channelId, id))
      return
    }
    case 'lfg.posted': {
      const { id, channelId, author, game } = body as Events['lfg.posted']
      if (isOnScreen(channelConv(serverKey, channelId))) return
      notice({ kind: 'posted', serverKey, channelId, id, game, accountKey: author, voiceChannelId: null })
      show(serverKey, t('lfg.notify.postedTitle', { name: name(author), game }), t('lfg.notify.postedBody'), openPost(serverKey, channelId, id))
    }
  }
})
