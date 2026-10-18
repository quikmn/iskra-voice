// @vitest-environment happy-dom
// Nothing mixes between accounts on one device: an account's page (a fresh module realm per account, as in the host's
// frames) only reaches its own localStorage keys and its own databases, and an existing single-account install keeps
// working as account 1 with nothing moved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountLink, HostApi } from '../platform/accountLink'
import { REGISTRY_KEY, parseRegistry } from '../platform/accountSlots'

const realLocal = Object.getOwnPropertyDescriptor(window, 'localStorage')
const realParent = Object.getOwnPropertyDescriptor(window, 'parent')
const raw = window.localStorage

/** IndexedDB that records which databases were opened and keeps a store per database. */
function recordingIndexedDb() {
  const opened: string[] = []
  const dbs = new Map<string, Map<string, unknown>>()
  const later = (fn: () => void) => setTimeout(fn, 0)
  const request = <T>(run: () => T) => {
    const r: { result?: T; error: null; onsuccess?: () => void; onerror?: () => void } = { error: null }
    later(() => {
      r.result = run()
      r.onsuccess?.()
    })
    return r
  }
  const dbFor = (data: Map<string, unknown>) => ({
    createObjectStore: () => undefined,
    transaction: () => {
      const tx: { error: null; oncomplete?: () => void; objectStore: () => unknown } = {
        error: null,
        objectStore: () => ({
          get: (key: string) => request(() => structuredClone(data.get(key))),
          put: (value: unknown, key: string) => {
            data.set(key, value)
            later(() => tx.oncomplete?.())
          },
          delete: (key: string) => {
            data.delete(key)
            later(() => tx.oncomplete?.())
          },
        }),
      }
      return tx
    },
  })
  return {
    opened,
    dbs,
    factory: {
      open: (name: string) => {
        opened.push(name)
        if (!dbs.has(name)) dbs.set(name, new Map())
        return request(() => dbFor(dbs.get(name)!))
      },
      deleteDatabase: (name: string) => request(() => dbs.delete(name)),
    },
  }
}

/** Loads the app's modules fresh, as the page for `slot` would (2+: in the host's frame). */
async function pageFor(slot: number) {
  vi.resetModules()
  for (const [name, d] of [['localStorage', realLocal], ['parent', realParent]] as const) {
    if (d) Object.defineProperty(window, name, d)
    else delete (window as unknown as Record<string, unknown>)[name]
  }
  if (slot > 1 || slot === -1) {
    const real = Math.abs(slot)
    window.history.replaceState(null, '', `/?account=${real}`)
    const host: HostApi = { version: 1, link: (s) => ({ slot: s } as AccountLink) }
    Object.defineProperty(window, 'parent', { configurable: true, get: () => ({ __iskraHost: host }) })
  } else {
    window.history.replaceState(null, '', '/')
  }
  await import('../platform/accountBoot')
}

beforeEach(() => {
  raw.clear()
  vi.useRealTimers()
})
afterEach(() => vi.unstubAllGlobals())

describe('keeping accounts apart', () => {
  it("an account's drafts and settings are its own", async () => {
    await pageFor(2)
    const two = await import('./drafts')
    two.setDraft('c:S:1', 'only bea')
    await vi.waitFor(() => expect(raw.getItem('iskra@2:iskra.drafts')).toContain('only bea'))
    expect(raw.getItem('iskra.drafts')).toBeNull()

    await pageFor(-1) // account 1, next to others: in a frame too
    const one = await import('./drafts')
    expect(one.useDrafts.getState().drafts).toEqual({})
    one.setDraft('c:S:1', 'only ada')
    await vi.waitFor(() => expect(raw.getItem('iskra.drafts')).toContain('only ada'))
    expect(raw.getItem('iskra@2:iskra.drafts')).toContain('only bea')
  })

  it('keys, servers and messages go to a database per account', async () => {
    const idb = recordingIndexedDb()
    vi.stubGlobal('indexedDB', idb.factory)
    await pageFor(3)
    const three = await import('../core/storage')
    await three.saveServers([{ url: 'https://three.example', serverKey: 'K', name: 'Three' }])
    await pageFor(1)
    const one = await import('../core/storage')
    expect(await one.loadServers()).toEqual([])
    expect(idb.opened).toContain('iskra@3')
    expect(idb.opened).toContain('iskra')
    expect(idb.dbs.get('iskra@3')!.get('servers')).toEqual([{ url: 'https://three.example', serverKey: 'K', name: 'Three' }])
  })

  it('an install from before several accounts is account 1, as it was: same database, same keys, no list stored', async () => {
    const idb = recordingIndexedDb()
    vi.stubGlobal('indexedDB', idb.factory)
    idb.dbs.set('iskra', new Map<string, unknown>([['servers', [{ url: 'https://old.example', serverKey: 'O', name: 'Old' }]]]))
    raw.setItem('iskra.drafts', JSON.stringify({ 'c:O:1': { text: 'from before', at: 1 } }))
    await pageFor(1)
    const boot = await import('../platform/accountBoot')
    expect(boot.bootMode).toBe('solo')
    const storage = await import('../core/storage')
    expect(await storage.loadServers()).toEqual([{ url: 'https://old.example', serverKey: 'O', name: 'Old' }])
    const drafts = await import('./drafts')
    expect(drafts.useDrafts.getState().drafts['c:O:1'].text).toBe('from before')
    expect(raw.getItem(REGISTRY_KEY)).toBeNull()
    expect(idb.opened).toEqual(['iskra'])
  })

  it('adding a second account to a single-account install lists both and restarts as their host', async () => {
    await pageFor(1)
    raw.setItem('iskra.audio', '{"input":"usb-mic"}')
    raw.setItem('iskra.drafts', '{"private":1}')
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload, search: '', pathname: '/', hash: '' })
    const accounts = await import('./accounts')
    accounts.addAccountHere('new')
    expect(reload).toHaveBeenCalled()
    const reg = parseRegistry(raw.getItem(REGISTRY_KEY))
    expect(reg).toMatchObject({ active: 2, order: [1, 2] })
    expect(reg.accounts[2].adding).toBe('new')
    // The new account starts with this device's sound settings, never the first account's content.
    expect(raw.getItem('iskra@2:iskra.audio')).toBe('{"input":"usb-mic"}')
    expect(raw.getItem('iskra@2:iskra.drafts')).toBeNull()
    expect(raw.getItem('iskra.drafts')).toBe('{"private":1}')
  })
})
