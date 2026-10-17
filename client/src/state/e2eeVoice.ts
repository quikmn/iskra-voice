// Encrypted voice channels while you're in one: which key version your media uses (e2eeChannels.ts switches it when
// the channel gets a new epoch) and who in the room publishes media that isn't encrypted (never played, see voice.ts).
import type { Room } from 'livekit-client'
import { create } from 'zustand'
import { lk } from './livekit'
import { activeRoom, useVoice } from './voice'
import { peerEncryption } from './e2eeVoiceLogic'

interface E2eeVoiceState {
  /** The channel key version our media is encrypted with now (null: not in an encrypted voice channel). */
  version: number | null
  /** People whose media arrives encrypted, and people publishing something unencrypted (sorted account keys). */
  encrypted: string[]
  unencrypted: string[]
}

export const useE2eeVoice = create<E2eeVoiceState>(() => ({ version: null, encrypted: [], unencrypted: [] }))

/** e2eeChannels.ts: the media key of this epoch is in use. */
export function setVoiceVersion(version: number | null): void {
  if (useE2eeVoice.getState().version !== version) useE2eeVoice.setState({ version })
}

let bound: Room | null = null
let unbind: (() => void) | null = null

function check(room: Room): void {
  const peers = [...room.remoteParticipants.values()].map((p) => ({ identity: p.identity, tracks: p.trackPublications.size, encrypted: p.isEncrypted }))
  const next = peerEncryption(peers)
  const now = useE2eeVoice.getState()
  if (next.encrypted.join() !== now.encrypted.join() || next.unencrypted.join() !== now.unencrypted.join()) useE2eeVoice.setState(next)
}

function bind(room: Room): () => void {
  const { RoomEvent } = lk()
  const events = [RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
    RoomEvent.ParticipantEncryptionStatusChanged, RoomEvent.TrackSubscribed] as const
  const onChange = () => check(room)
  for (const e of events) room.on(e, onChange)
  check(room)
  return () => {
    for (const e of events) room.off(e, onChange)
  }
}

useVoice.subscribe((state, prev) => {
  if (state.session === prev.session) return
  const session = state.session
  // Only encrypted voice channels: DM and group calls have their own badges, and in a plain channel nobody's media is
  // meant to be encrypted (marking them would be a false alarm).
  const room = session?.encrypted && !session.call && !session.group ? activeRoom() : null
  if (!session || session.call || session.group) setVoiceVersion(null)
  if (room === bound) return
  unbind?.()
  unbind = null
  bound = room
  useE2eeVoice.setState({ encrypted: [], unencrypted: [] })
  if (room) unbind = bind(room)
})
