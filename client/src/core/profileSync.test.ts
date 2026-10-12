import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'
import { openPrefs, prefsKey, sealPrefs } from './prefs'
import { authProfile, profileForLink, profileFromLink, sha256Hex } from './profile'
import { adopt, compareStamps, MAX_AHEAD, missing, nextStamp, parseSynced, PROFILE_PREF, stampOf, toSynced, wireStamp } from './profileSync'
import type { Profile } from './storage'

beforeAll(async () => {
  await sodium.ready
})

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('profile stamps', () => {
  it('orders by time, then by device, the same way everywhere', () => {
    expect(compareStamps({ updatedAt: 2, by: 'a' }, { updatedAt: 1, by: 'z' })).toBe(1)
    expect(compareStamps({ updatedAt: 1, by: 'a' }, { updatedAt: 1, by: 'b' })).toBe(-1)
    expect(compareStamps({ updatedAt: 1, by: 'b' }, { updatedAt: 1, by: 'b' })).toBe(0)
    // Two devices editing in the same millisecond: both pick the same winner.
    const a = { updatedAt: 5, by: 'dev-A' }
    const b = { updatedAt: 5, by: 'dev-B' }
    expect(compareStamps(a, b)).toBe(-compareStamps(b, a))
    // Unstamped is the oldest.
    expect(compareStamps(stampOf(undefined), { updatedAt: 1, by: '' })).toBe(-1)
  })

  it('never stamps an edit older than what this device knows, but ignores a clock far ahead', () => {
    expect(nextStamp(undefined, 'me', 1000)).toEqual({ updatedAt: 1000, by: 'me' })
    // This clock is behind the other device's: the edit still wins over what it adopted.
    expect(nextStamp({ updatedAt: 5000 }, 'me', 1000)).toEqual({ updatedAt: 5001, by: 'me' })
    expect(nextStamp({ updatedAt: 1000 + MAX_AHEAD + 1 }, 'me', 1000)).toEqual({ updatedAt: 1000, by: 'me' })
  })

  it('goes with auth and requests only when the profile has one', () => {
    expect(wireStamp({ name: 'x' } as Profile)).toEqual({})
    expect(wireStamp({ updatedAt: 7, by: 'd' })).toEqual({ updatedAt: 7, by: 'd' })
    expect(authProfile({ name: 'x', bio: 'b', updatedAt: 7, by: 'd' })).toEqual({ bio: 'b', updatedAt: 7, by: 'd' })
    expect(authProfile({ name: 'x' })).toEqual({})
  })

  it('travels with device linking', () => {
    const linked = profileFromLink(JSON.parse(JSON.stringify(profileForLink({ name: 'x', updatedAt: 9, by: 'd' }))))
    expect(linked).toMatchObject({ updatedAt: 9, by: 'd' })
    expect(profileFromLink({ updatedAt: 'soon', by: 'd' }).updatedAt).toBeUndefined()
  })
})

describe('the account copy', () => {
  const avatar = bytes('png bytes')
  const page = '<p>hi</p>'
  const full: Profile = {
    name: 'Alicia', bio: 'bass', pronouns: 'she/her', accent: '#ff8800', recoverySaved: true,
    avatar: { bytes: avatar, type: 'image/png', hash: sha256Hex(new Uint8Array(avatar)) },
    page: { html: page, hash: sha256Hex(new TextEncoder().encode(page)) },
    updatedAt: 2000, by: 'dev-a',
  }

  it('carries hashes, not bytes, and survives sealing', () => {
    const copy = toSynced(full)!
    expect(copy).toEqual({
      v: 1, updatedAt: 2000, by: 'dev-a', name: 'Alicia', bio: 'bass', pronouns: 'she/her', accent: '#ff8800',
      avatar: { hash: full.avatar!.hash, type: 'image/png' }, page: { hash: full.page!.hash },
    })
    expect(JSON.stringify(copy).length).toBeLessThan(16 * 1024)
    const key = prefsKey(sodium.randombytes_buf(32))
    const sealed = sealPrefs(key, PROFILE_PREF, JSON.stringify(copy))
    expect(parseSynced(openPrefs(key, PROFILE_PREF, sealed)!, 3000)).toEqual(copy)
    // Can't be passed off as another setting.
    expect(openPrefs(key, 'rail', sealed)).toBeNull()
    expect(toSynced({ name: 'unstamped' })).toBeNull()
  })

  it('rejects malformed copies and ones from a clock far ahead', () => {
    const ok = { v: 1, updatedAt: 10, by: 'd', name: 'A' }
    expect(parseSynced(JSON.stringify(ok), 10)).toEqual(ok)
    expect(parseSynced('not json')).toBeNull()
    expect(parseSynced(JSON.stringify({ ...ok, v: 2 }))).toBeNull()
    expect(parseSynced(JSON.stringify({ ...ok, name: '' }))).toBeNull()
    expect(parseSynced(JSON.stringify({ ...ok, bio: 'x'.repeat(191) }))).toBeNull()
    expect(parseSynced(JSON.stringify({ ...ok, accent: 'red' }))).toBeNull()
    expect(parseSynced(JSON.stringify({ ...ok, avatar: { hash: 'nothex', type: 'image/png' } }))).toBeNull()
    expect(parseSynced(JSON.stringify({ ...ok, avatar: { hash: 'a'.repeat(64), type: 'text/html' } }))).toBeNull()
    expect(parseSynced(JSON.stringify({ ...ok, updatedAt: 10 + MAX_AHEAD + 1 }), 10)).toBeNull()
    expect(parseSynced(JSON.stringify({ ...ok, avatar: null, page: null }), 10)).toMatchObject({ avatar: null, page: null })
  })

  it('a device with an old profile takes the newer one, bytes checked against the hashes', () => {
    const old: Profile = { name: 'Alice', bio: 'old', recoverySaved: false, updatedAt: 1000, by: 'dev-b' }
    const copy = toSynced(full)!
    expect(missing(old, copy)).toEqual({ avatar: copy.avatar, page: copy.page })
    // Until the files are here, nothing is taken.
    expect(adopt(old, copy)).toBeNull()
    expect(adopt(old, copy, { avatar: bytes('other'), page })).toBeNull()
    expect(adopt(old, copy, { avatar, page: '<p>tampered</p>' })).toBeNull()

    const next = adopt(old, copy, { avatar, page })!
    expect(next).toMatchObject({ name: 'Alicia', bio: 'bass', pronouns: 'she/her', accent: '#ff8800', updatedAt: 2000, by: 'dev-a' })
    expect(next.recoverySaved).toBe(false) // stays a per-device fact
    expect(next.avatar!.hash).toBe(full.avatar!.hash)
    expect(next.page!.html).toBe(page)
    expect(missing(next, copy)).toEqual({})
  })

  it('keeps what the copy never set, and removes what it removed', () => {
    const local: Profile = { name: 'A', pronouns: 'they/them', avatar: full.avatar, page: full.page }
    const next = adopt(local, { v: 1, updatedAt: 5, by: 'd', name: 'B', avatar: null, page: null })!
    expect(next).toMatchObject({ name: 'B', pronouns: 'they/them', avatar: null, page: null })
    // Same avatar already here: nothing to fetch.
    expect(adopt(local, { v: 1, updatedAt: 5, by: 'd', name: 'B', avatar: { hash: full.avatar!.hash, type: 'image/png' } })!.avatar).toBe(full.avatar)
  })
})
