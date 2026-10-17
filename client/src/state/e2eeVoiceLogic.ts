// Encrypted voice channels, the parts without a room: which epoch keys go into LiveKit's key slots, and who in the
// room isn't sending encrypted media.
import { voiceKey, voiceKeyIndex } from '../core/channelChain'

/** How many earlier epochs' keys stay loaded, so frames still sent under them decrypt while everyone switches. */
export const PREVIOUS_EPOCHS = 2

export interface VoiceKeySet {
  key: Uint8Array
  index: number
  version: number
  previous: { key: Uint8Array; index: number; version: number }[]
}

/**
 * The media keys for joining at `version`: its own key (the one we send with) and the keys of up to
 * {@link PREVIOUS_EPOCHS} epochs before it that this device holds, oldest first. Null: no key for `version`.
 */
export function voiceKeySet(keys: ReadonlyMap<number, Uint8Array>, version: number): VoiceKeySet | null {
  const current = keys.get(version)
  if (!current) return null
  const previous: VoiceKeySet['previous'] = []
  for (let v = Math.max(1, version - PREVIOUS_EPOCHS); v < version; v++) {
    const epoch = keys.get(v)
    if (epoch) previous.push({ key: voiceKey(epoch), index: voiceKeyIndex(v), version: v })
  }
  return { key: voiceKey(current), index: voiceKeyIndex(version), version, previous }
}

/** A new epoch only replaces the media key when it's newer than the one in use (keys can arrive out of order). */
export const shouldSwitch = (inUse: number | null, next: number): boolean => inUse === null || next > inUse

/** What a remote participant in the room is publishing, as far as encryption goes. */
export interface PeerMedia {
  identity: string
  tracks: number
  encrypted: boolean
}

/**
 * Who in the room sends encrypted media (every track they publish) and who publishes something unencrypted (apps never
 * play it; the UI says so). People publishing nothing are in neither list.
 */
export function peerEncryption(peers: PeerMedia[]): { encrypted: string[]; unencrypted: string[] } {
  const publishing = peers.filter((p) => p.tracks > 0)
  return {
    encrypted: publishing.filter((p) => p.encrypted).map((p) => p.identity).sort(),
    unencrypted: publishing.filter((p) => !p.encrypted).map((p) => p.identity).sort(),
  }
}
