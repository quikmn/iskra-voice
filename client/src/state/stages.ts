// Stage channels: a few speakers, many listeners. The server decides who speaks (and tells LiveKit);
// this only mirrors its state and sends requests.
import { create } from 'zustand'
import { roleRank, type Channel, type Events, type Requests, type StageState, type VoiceParticipant } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, type ServerState } from './store'
import { t } from '../i18n'

/** `${serverKey}:${channelId}` → the server's latest state of that stage. */
export const useStages = create<{ stages: Record<string, StageState> }>(() => ({ stages: {} }))

const stageKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

export const stageFor = (serverKey: string, channelId: number) => (s: { stages: Record<string, StageState> }) =>
  s.stages[stageKey(serverKey, channelId)] as StageState | undefined

function put(serverKey: string, state: StageState): void {
  useStages.setState((s) => ({ stages: { ...s.stages, [stageKey(serverKey, state.channelId)]: state } }))
}

onWelcomeHook((serverKey, welcome) => {
  useStages.setState((s) => {
    const stages = Object.fromEntries(Object.entries(s.stages).filter(([k]) => !k.startsWith(`${serverKey}:`)))
    for (const state of welcome.stages ?? []) stages[stageKey(serverKey, state.channelId)] = state
    return { stages }
  })
})

onServerEvent((serverKey, type, body) => {
  if (type === 'stage.state') put(serverKey, body as Events['stage.state'])
})

/** Admins moderate every stage; admins can also pick moderators per stage. Mirrors StageRegistry.IsModerator. */
export function isStageModerator(server: ServerState, state: StageState | undefined, accountKey: string): boolean {
  const member = server.members[accountKey]
  if (!member) return false
  return roleRank(member.role) >= roleRank('admin') || !!state?.moderators.includes(accountKey)
}

/** Who may raise a hand or be brought up: moderators and the channel's writers. Mirrors StageRegistry.MaySpeak. */
export function maySpeak(server: ServerState, channel: Channel, state: StageState | undefined, accountKey: string): boolean {
  const member = server.members[accountKey]
  if (!member) return false
  return isStageModerator(server, state, accountKey) || roleRank(member.role) >= roleRank(channel.writeRole)
}

export interface StageView {
  /** In the room and allowed to publish, in the order they were brought up. */
  speakers: VoiceParticipant[]
  /** Everyone else in the room; raised hands first (oldest first), then by join order. */
  audience: VoiceParticipant[]
  /** Raised hands of people still in the room, oldest first. */
  hands: string[]
}

/** Splits the people in the room into speakers and audience. */
export function stageView(state: StageState | undefined, participants: VoiceParticipant[]): StageView {
  const byKey = new Map(participants.map((p) => [p.accountKey, p]))
  const speakerKeys = state?.speakers ?? []
  const speakers = speakerKeys.map((k) => byKey.get(k)).filter((p): p is VoiceParticipant => !!p)
  const hands = (state?.hands ?? []).map((h) => h.accountKey).filter((k) => byKey.has(k) && !speakerKeys.includes(k))
  const rest = participants.filter((p) => !speakerKeys.includes(p.accountKey) && !hands.includes(p.accountKey))
  return { speakers, audience: [...hands.map((k) => byKey.get(k)!), ...rest], hands }
}

/** "1 listening", "12 listening". */
export const listenerLabel = (count: number) => t('stage.listening', { count })

async function send<K extends keyof Requests>(serverKey: string, type: K, body: Requests[K][0]): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error(t('stage.notConnected'))
  await connection.request(type, body)
}

export const startStage = (serverKey: string, channelId: number, topic: string) => send(serverKey, 'stage.start', { channelId, topic })
export const setStageTopic = (serverKey: string, channelId: number, topic: string) => send(serverKey, 'stage.update', { channelId, topic })
export const endStage = (serverKey: string, channelId: number) => send(serverKey, 'stage.end', { channelId })
export const setHand = (serverKey: string, channelId: number, raised: boolean) => send(serverKey, 'stage.hand', { channelId, raised })
export const inviteToSpeak = (serverKey: string, channelId: number, accountKey: string) => send(serverKey, 'stage.invite', { channelId, accountKey })
export const declineHand = (serverKey: string, channelId: number, accountKey: string) => send(serverKey, 'stage.decline', { channelId, accountKey })
export const moveToAudience = (serverKey: string, channelId: number, accountKey?: string) =>
  send(serverKey, 'stage.audience', accountKey ? { channelId, accountKey } : { channelId })
export const muteSpeaker = (serverKey: string, channelId: number, accountKey: string) => send(serverKey, 'stage.mute', { channelId, accountKey })
export const removeFromStage = (serverKey: string, channelId: number, accountKey: string) => send(serverKey, 'stage.remove', { channelId, accountKey })
export const setStageModerator = (serverKey: string, channelId: number, accountKey: string, on: boolean) =>
  send(serverKey, 'stage.moderator', { channelId, accountKey, on })
