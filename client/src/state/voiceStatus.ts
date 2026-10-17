// Voice channel status ("CS2 ranked"): what each server says in voice.state and the welcome, and setting or clearing
// it. The server checks who may and clears it when the call empties; this only keeps what it says.
import { create } from 'zustand'
import type { Events, VoiceStatus, Welcome } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook } from './store'

type Statuses = Record<string, Record<number, VoiceStatus>>

export const useVoiceStatus = create<Statuses>(() => ({}))

function keep(serverKey: string, channelId: number, status: VoiceStatus | null | undefined): void {
  useVoiceStatus.setState((all) => {
    const mine = { ...all[serverKey] }
    if (status) mine[channelId] = status
    else delete mine[channelId]
    return { [serverKey]: mine }
  })
}

const NONE = undefined
export const useChannelStatus = (serverKey: string, channelId: number): VoiceStatus | undefined =>
  useVoiceStatus((s) => s[serverKey]?.[channelId] ?? NONE)

/** Sets it (empty text clears it). Throws the server's error. */
export async function setVoiceStatus(serverKey: string, channelId: number, text: string): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection) throw new Error('not connected')
  const { status } = await connection.request('voice.status.set', { channelId, text })
  keep(serverKey, channelId, status)
}

onWelcomeHook((serverKey, welcome: Welcome) => {
  const mine: Record<number, VoiceStatus> = {}
  for (const v of welcome.voice ?? []) if (v.status) mine[v.channelId] = v.status
  useVoiceStatus.setState({ [serverKey]: mine })
})

onServerEvent((serverKey, type, body) => {
  if (type === 'voice.state') {
    const state = body as Events['voice.state']
    if ('status' in state) keep(serverKey, state.channelId, state.status)
  } else if (type === 'voice.available' && !(body as Events['voice.available']).available) {
    useVoiceStatus.setState({ [serverKey]: {} }) // LiveKit stopped: every call ended
  }
})
