// @vitest-environment happy-dom
// Which account a page is for, decided before anything else runs (platform/accountBoot.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountLink, HostApi } from './accountLink'
import { REGISTRY_KEY, serializeRegistry, singleRegistry, addAccount } from './accountSlots'

const realLocal = Object.getOwnPropertyDescriptor(window, 'localStorage')
const realSession = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
const realParent = Object.getOwnPropertyDescriptor(window, 'parent')

async function boot() {
  vi.resetModules()
  const mod = await import('./accountBoot')
  const slot = await import('../core/accountSlot')
  return { ...mod, slot: slot.accountSlot(), db: slot.slotDbName('iskra') }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  for (const [name, d] of [['localStorage', realLocal], ['sessionStorage', realSession], ['parent', realParent]] as const) {
    if (d) Object.defineProperty(window, name, d)
    else delete (window as unknown as Record<string, unknown>)[name]
  }
  window.history.replaceState(null, '', '/')
})

describe('starting a page', () => {
  it('runs a device with one account exactly as before: account 1, the same storage, nothing added', async () => {
    localStorage.setItem('iskra.drafts', 'mine')
    const raw = window.localStorage
    const b = await boot()
    expect(b.bootMode).toBe('solo')
    expect(b.slot).toBe(1)
    expect(b.db).toBe('iskra')
    expect(window.localStorage).toBe(raw) // not even wrapped
    expect(localStorage.getItem('iskra.drafts')).toBe('mine')
    expect(localStorage.getItem(REGISTRY_KEY)).toBeNull()
  })

  it('becomes the host with several accounts, and keeps no account storage of its own', async () => {
    localStorage.setItem(REGISTRY_KEY, serializeRegistry(addAccount(singleRegistry(), 'new')!.registry))
    const raw = window.localStorage
    const b = await boot()
    expect(b.bootMode).toBe('host')
    expect(b.bootSlot).toBe(0)
    expect(window.localStorage).toBe(raw)
  })

  it('a single account in another slot gets its own view of storage', async () => {
    localStorage.setItem(REGISTRY_KEY, serializeRegistry(singleRegistry(3)))
    localStorage.setItem('iskra.drafts', 'account one left this')
    const b = await boot()
    expect(b.bootMode).toBe('solo')
    expect(b.slot).toBe(3)
    expect(b.db).toBe('iskra@3')
    expect(localStorage.getItem('iskra.drafts')).toBeNull()
    localStorage.setItem('iskra.drafts', 'three')
    expect(b.rawLocalStorage!.getItem('iskra@3:iskra.drafts')).toBe('three')
    expect(b.storageIsolated).toBe(true)
  })

  it("in the host's frame for account 2: its link, its slot, and only its own keys", async () => {
    window.history.replaceState(null, '', '/?account=2')
    const asked: number[] = []
    const link = { slot: 2 } as AccountLink
    const host: HostApi = { version: 1, link: (slot, win) => (asked.push(slot), win === window ? link : null) }
    Object.defineProperty(window, 'parent', { configurable: true, get: () => ({ __iskraHost: host }) })
    localStorage.setItem('iskra.drafts', 'account one')
    sessionStorage.setItem('iskra.s', 'one')
    const b = await boot()
    expect(asked).toEqual([2])
    expect(b.bootMode).toBe('frame')
    expect(b.accountLink).toBe(link)
    expect(b.slot).toBe(2)
    expect(b.db).toBe('iskra@2')
    expect(localStorage.getItem('iskra.drafts')).toBeNull()
    expect(sessionStorage.getItem('iskra.s')).toBeNull()
    localStorage.setItem('iskra.drafts', 'two')
    expect(b.rawLocalStorage!.getItem('iskra.drafts')).toBe('account one')
    expect(b.rawLocalStorage!.getItem('iskra@2:iskra.drafts')).toBe('two')
  })

  it("a frame the host doesn't vouch for (or another site's parent) is no account frame", async () => {
    window.history.replaceState(null, '', '/?account=2')
    Object.defineProperty(window, 'parent', { configurable: true, get: () => ({ __iskraHost: { version: 1, link: () => null } }) })
    expect((await boot()).bootMode).toBe('solo')
    Object.defineProperty(window, 'parent', {
      configurable: true,
      get: () => new Proxy({}, { get: () => { throw new DOMException('Blocked a frame', 'SecurityError') } }),
    })
    const b = await boot()
    expect(b.bootMode).toBe('solo')
    expect(b.accountLink).toBeNull()
  })
})
