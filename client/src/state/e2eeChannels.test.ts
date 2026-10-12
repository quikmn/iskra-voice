import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CHANNEL_MEMBERS, MissingKeyError, type ChannelChange } from '../core/channelChain'
import { en } from '../i18n/en'
import { GroupBehindError, GroupError, setGroupKeyResolver } from '../core/group'
import { BEFORE_YOU_JOINED, decryptFailure } from './e2eeChannels'

const A = 'a'.repeat(43)
const B = 'b'.repeat(43)
const B_OLD = 'o'.repeat(43)
const change = (version: number, members: string[]) => ({ version, members }) as unknown as ChannelChange
// Bob joined at version 2: version 1 was sent before he could read the channel.
const view = { changes: [change(1, [A]), change(2, [A, B]), change(3, [A, B])] }
const noKey = () => new MissingKeyError("This device doesn't have the key for this message.")

describe('a message that did not decrypt', () => {
  afterEach(() => setGroupKeyResolver((k) => k))

  it('from an epoch you were not in: a clear error, never retried', () => {
    expect(decryptFailure(noKey(), view, 1, B, false)).toEqual({ state: 'error', error: BEFORE_YOU_JOINED })
    expect(decryptFailure(noKey(), view, 1, B, true)).toEqual({ state: 'error', error: BEFORE_YOU_JOINED })
  })

  it('from an epoch you were in: fetches the keys, then waits to retry', () => {
    expect(decryptFailure(noKey(), view, 2, B, false)).toBe('sync')
    const shown = decryptFailure(noKey(), view, 3, B, true)
    expect(shown).toMatchObject({ state: 'error', retry: true })
    expect(shown).not.toMatchObject({ error: BEFORE_YOU_JOINED })
  })

  it('counts you in under an earlier account key (after a key rotation)', () => {
    const rotated = { changes: [change(1, [A, B_OLD])] }
    setGroupKeyResolver((k) => (k === B_OLD ? B : k))
    expect(decryptFailure(noKey(), rotated, 1, B, false)).toBe('sync')
  })

  it('a chain that is behind always syncs; other errors are shown as they are', () => {
    expect(decryptFailure(new GroupBehindError('behind'), view, 9, B, true)).toBe('sync')
    expect(decryptFailure(new GroupError('bad signature'), view, 2, B, false)).toEqual({ state: 'error', error: 'bad signature' })
  })

  it('an unknown epoch or no identity is never "you were in"', () => {
    expect(decryptFailure(noKey(), view, 7, B, false)).toEqual({ state: 'error', error: BEFORE_YOU_JOINED })
    expect(decryptFailure(noKey(), view, 2, '', false)).toEqual({ state: 'error', error: BEFORE_YOU_JOINED })
  })
})

describe('e2ee error texts', () => {
  it('the translated "too many" error matches the limit the client enforces', () => {
    expect(en.e2ee.errors.tooMany).toBe(`At most ${MAX_CHANNEL_MEMBERS} people can be in an encrypted channel.`)
  })
})
