import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, ready } from '../core/crypto'
import { newEpochKey, voiceKey } from '../core/channelChain'
import { peerEncryption, PREVIOUS_EPOCHS, shouldSwitch, voiceKeySet } from './e2eeVoiceLogic'

beforeAll(ready)

const epochs = (...versions: number[]) => new Map(versions.map((v) => [v, newEpochKey()] as const))

describe('media keys of an encrypted voice channel', () => {
  it('derive from the epoch key with the libsodium KDF (context iskra-vc, subkey 1), never the epoch key itself', () => {
    const epoch = new Uint8Array(32).map((_, i) => i)
    const expected = sodium.crypto_kdf_derive_from_key(32, 1, 'iskra-vc', epoch)
    expect(b64u(voiceKey(epoch))).toBe(b64u(expected))
    expect(b64u(voiceKey(epoch))).not.toBe(b64u(epoch))
  })

  it('use the current epoch for sending, in slot version mod 16', () => {
    const keys = epochs(1, 2, 3)
    const set = voiceKeySet(keys, 3)!
    expect(set.version).toBe(3)
    expect(set.index).toBe(3)
    expect(b64u(set.key)).toBe(b64u(voiceKey(keys.get(3)!)))
    expect(voiceKeySet(epochs(17), 17)!.index).toBe(1)
  })

  it('keep the epochs just before it (oldest first), so people still switching are heard', () => {
    const keys = epochs(1, 2, 3, 4, 5)
    const set = voiceKeySet(keys, 5)!
    expect(set.previous.map((p) => p.version)).toEqual([5 - PREVIOUS_EPOCHS, 4])
    expect(set.previous.map((p) => p.index)).toEqual([3, 4])
    expect(b64u(set.previous[1].key)).toBe(b64u(voiceKey(keys.get(4)!)))
    // Every epoch gets its own key: someone removed at version 5 holds nothing that decrypts it.
    const all = [set.key, ...set.previous.map((p) => p.key)].map(b64u)
    expect(new Set(all).size).toBe(all.length)
  })

  it('skip earlier epochs this device never had, and refuse without the current one', () => {
    const joinedLate = epochs(4)
    expect(voiceKeySet(joinedLate, 4)!.previous).toEqual([])
    expect(voiceKeySet(epochs(1, 2), 3)).toBeNull()
  })

  it('only switch forward (keys can arrive out of order)', () => {
    expect(shouldSwitch(null, 1)).toBe(true)
    expect(shouldSwitch(2, 3)).toBe(true)
    expect(shouldSwitch(3, 3)).toBe(false)
    expect(shouldSwitch(3, 2)).toBe(false)
  })
})

describe('who sends encrypted media', () => {
  it('splits people publishing something by encryption, leaving out listeners', () => {
    expect(peerEncryption([
      { identity: 'carol', tracks: 1, encrypted: true },
      { identity: 'mallory', tracks: 2, encrypted: false },
      { identity: 'bob', tracks: 2, encrypted: true },
      { identity: 'listener', tracks: 0, encrypted: false },
    ])).toEqual({ encrypted: ['bob', 'carol'], unencrypted: ['mallory'] })
  })
})
