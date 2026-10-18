// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { slotDbName } from '../core/accountSlot'
import {
  addAccount, DEVICE_KEYS, keyPrefix, MAX_ACCOUNTS, moveAccount, namespacedStorage, parseRegistry, REGISTRY_KEY, removeAccount, seedSettings,
  serializeRegistry, singleRegistry, slotWithKey, storedKey, updateEntry, wipeSlot,
} from './accountSlots'

const KEY_A = 'A'.repeat(43)

describe('the list of accounts on this device', () => {
  it('is account 1 alone when nothing is stored (every install from before several accounts)', () => {
    expect(parseRegistry(null)).toEqual(singleRegistry())
    expect(parseRegistry('not json')).toEqual(singleRegistry())
    expect(parseRegistry(JSON.stringify({ v: 2, order: [1, 2] }))).toEqual(singleRegistry())
    expect(parseRegistry(JSON.stringify({ v: 1, order: [] }))).toEqual(singleRegistry())
  })

  it('keeps only what it can check', () => {
    const parsed = parseRegistry(JSON.stringify({
      v: 1, active: 9, order: [2, 2, 'x', 0, -1, 1.5, 3],
      accounts: { 2: { name: 'Bea', key: KEY_A, adding: 'nope', secret: 'leak' }, 3: { name: 7, key: 'short', adding: 'link' } },
    }))
    expect(parsed).toEqual({ v: 1, active: 2, order: [2, 3], accounts: { 2: { slot: 2, name: 'Bea', key: KEY_A }, 3: { slot: 3, adding: 'link' } } })
    expect(parseRegistry(serializeRegistry(parsed))).toEqual(parsed)
  })

  it('adds accounts in the lowest free slot, opens them, and stops at the limit', () => {
    let reg = singleRegistry()
    const added = addAccount(reg, 'new')!
    expect(added.slot).toBe(2)
    expect(added.registry).toMatchObject({ active: 2, order: [1, 2], accounts: { 2: { slot: 2, adding: 'new' } } })
    reg = added.registry
    reg = removeAccount(reg, 1)
    expect(reg).toMatchObject({ active: 2, order: [2] })
    expect(addAccount(reg, 'link')!.slot).toBe(1) // slot 1 is free again (its storage was wiped when it signed out)
    for (let i = 0; i < MAX_ACCOUNTS - 1; i++) reg = addAccount(reg, 'new')!.registry
    expect(reg.order).toHaveLength(MAX_ACCOUNTS)
    expect(addAccount(reg, 'new')).toBeNull()
    expect(addAccount(singleRegistry(), 'new', 1)).toBeNull()
  })

  it('removes, reorders and updates entries', () => {
    let reg = addAccount(addAccount(singleRegistry(), 'new')!.registry, 'new')!.registry // [1, 2, 3], active 3
    expect(removeAccount(reg, 3, 1)).toMatchObject({ active: 1, order: [1, 2] })
    expect(removeAccount(reg, 2)).toMatchObject({ active: 3, order: [1, 3] })
    expect(moveAccount(reg, 3, -1).order).toEqual([1, 3, 2])
    expect(moveAccount(reg, 1, -1).order).toEqual([1, 2, 3])
    reg = updateEntry(reg, 2, { name: 'Bea', key: KEY_A, adding: undefined })
    expect(reg.accounts[2]).toEqual({ slot: 2, name: 'Bea', key: KEY_A })
    expect(slotWithKey(reg, KEY_A, 3)).toBe(2)
    expect(slotWithKey(reg, KEY_A, 2)).toBeNull()
  })
})

describe("each account's Web Storage", () => {
  beforeEach(() => localStorage.clear())

  it('keeps account 1 on the names it always had, so an existing install needs no migration', () => {
    localStorage.setItem('iskra.drafts', '{"c":"hi"}')
    const one = namespacedStorage(localStorage, 1)
    expect(one.getItem('iskra.drafts')).toBe('{"c":"hi"}')
    one.setItem('iskra.notify', '{}')
    expect(localStorage.getItem('iskra.notify')).toBe('{}')
    expect(storedKey(1, 'iskra.voice')).toBe('iskra.voice')
    expect(keyPrefix(1)).toBe('')
    expect(slotDbName('iskra', 1)).toBe('iskra')
    expect(slotDbName('iskra', 4)).toBe('iskra@4')
  })

  it("never lets one account see or change another's keys, or the list of accounts", () => {
    localStorage.setItem(REGISTRY_KEY, serializeRegistry(singleRegistry()))
    const one = namespacedStorage(localStorage, 1)
    const two = namespacedStorage(localStorage, 2)
    const three = namespacedStorage(localStorage, 3)
    one.setItem('iskra.drafts', 'one')
    two.setItem('iskra.drafts', 'two')
    expect(localStorage.getItem('iskra@2:iskra.drafts')).toBe('two')
    expect(one.getItem('iskra.drafts')).toBe('one')
    expect(two.getItem('iskra.drafts')).toBe('two')
    expect(three.getItem('iskra.drafts')).toBeNull()
    // Account 1's page can't reach the others by their stored names either, nor the list.
    expect(one.getItem('iskra@2:iskra.drafts')).toBeNull()
    one.setItem('iskra@2:iskra.drafts', 'planted')
    one.removeItem('iskra@2:iskra.drafts')
    expect(localStorage.getItem('iskra@2:iskra.drafts')).toBe('two')
    expect(one.getItem(REGISTRY_KEY)).toBeNull()
    two.setItem(REGISTRY_KEY, 'x')
    expect(localStorage.getItem(REGISTRY_KEY)).toBe(serializeRegistry(singleRegistry()))
    // Listing keys (what signing out does) shows each account only its own.
    expect(Object.keys(one)).toEqual(['iskra.drafts'])
    expect(Object.keys(two)).toEqual(['iskra.drafts'])
    expect(two.length).toBe(1)
    expect(two.key(0)).toBe('iskra.drafts')
    expect((two as unknown as Record<string, string>)['iskra.drafts']).toBe('two')
  })

  it('shares only the device settings (language and theme)', () => {
    const one = namespacedStorage(localStorage, 1)
    const two = namespacedStorage(localStorage, 2)
    one.setItem('iskra.theme', '{"id":"midnight"}')
    expect(two.getItem('iskra.theme')).toBe('{"id":"midnight"}')
    two.setItem('iskra.language', 'sv')
    expect(localStorage.getItem('iskra.language')).toBe('sv')
    expect(DEVICE_KEYS).toEqual(['iskra.language', 'iskra.theme'])
    // Not counted as an account's own, so clearing an account leaves them.
    expect(Object.keys(two)).toEqual([])
    two.setItem('iskra.voice', 'v')
    two.clear()
    one.setItem('iskra.voice', 'mine')
    one.clear()
    expect(localStorage.getItem('iskra.theme')).toBe('{"id":"midnight"}')
    expect(localStorage.getItem('iskra.language')).toBe('sv')
    expect(localStorage.getItem('iskra@2:iskra.voice')).toBeNull()
    expect(localStorage.getItem('iskra.voice')).toBeNull()
  })

  it("clearing one account (signing out) leaves every other account's keys", () => {
    localStorage.setItem(REGISTRY_KEY, 'list')
    const one = namespacedStorage(localStorage, 1)
    const two = namespacedStorage(localStorage, 2)
    one.setItem('iskra.a', '1')
    two.setItem('iskra.a', '2')
    two.clear()
    expect(one.getItem('iskra.a')).toBe('1')
    two.setItem('iskra.a', '2')
    one.clear()
    expect(two.getItem('iskra.a')).toBe('2')
    expect(localStorage.getItem(REGISTRY_KEY)).toBe('list')
  })

  it('starts a new account with the sound, voice and hotkey settings of the one that added it', () => {
    localStorage.setItem('iskra.audio', '{"input":"mic-1"}')
    localStorage.setItem('iskra.hotkeys', '{"web":{}}')
    localStorage.setItem('iskra.drafts', 'private')
    localStorage.setItem('iskra@3:iskra.voice', 'kept')
    localStorage.setItem('iskra.voice', 'from-one')
    seedSettings(localStorage, 1, 3)
    expect(localStorage.getItem('iskra@3:iskra.audio')).toBe('{"input":"mic-1"}')
    expect(localStorage.getItem('iskra@3:iskra.hotkeys')).toBe('{"web":{}}')
    expect(localStorage.getItem('iskra@3:iskra.drafts')).toBeNull() // only settings, never content
    expect(localStorage.getItem('iskra@3:iskra.voice')).toBe('kept') // never overwrites
  })

  it('wipes everything a slot kept: its keys and its databases, nothing else', async () => {
    localStorage.setItem('iskra.a', 'one')
    localStorage.setItem('iskra@2:iskra.a', 'two')
    localStorage.setItem('iskra@2:iskra.theme', 'stray')
    localStorage.setItem('iskra.theme', 'device')
    sessionStorage.setItem('iskra@2:iskra.s', 'x')
    const deleted: string[] = []
    const idb = {
      deleteDatabase(name: string) {
        deleted.push(name)
        const request: { onsuccess?: () => void } = {}
        setTimeout(() => request.onsuccess?.(), 0)
        return request
      },
    } as unknown as IDBFactory
    await wipeSlot(2, { local: localStorage, session: sessionStorage, idb })
    expect(localStorage.getItem('iskra@2:iskra.a')).toBeNull()
    expect(localStorage.getItem('iskra@2:iskra.theme')).toBeNull()
    expect(sessionStorage.getItem('iskra@2:iskra.s')).toBeNull()
    expect(localStorage.getItem('iskra.a')).toBe('one')
    expect(localStorage.getItem('iskra.theme')).toBe('device')
    expect(deleted.sort()).toEqual(['iskra-transcripts@2', 'iskra@2'])
  })
})
