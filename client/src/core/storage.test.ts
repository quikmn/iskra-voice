import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ready } from './crypto'
import { isSealed } from './vault'

beforeAll(ready)

/** Just enough IndexedDB for storage.ts (one database, one object store, values kept as given). */
function fakeIndexedDb(data: Map<string, unknown>) {
  const later = (fn: () => void) => setTimeout(fn, 0)
  const request = <T>(run: () => T) => {
    const r: { result?: T; error: null; onsuccess?: () => void; onerror?: () => void } = { error: null }
    later(() => {
      r.result = run()
      r.onsuccess?.()
    })
    return r
  }
  const db = {
    createObjectStore: () => undefined,
    transaction: () => {
      const tx: { error: null; oncomplete?: () => void; onerror?: () => void; objectStore: () => unknown } = {
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
  }
  return {
    open: () => request(() => db),
    deleteDatabase: () => request(() => data.clear()),
  }
}

/** A device from before encryption at rest: keys stored in the clear, no vault yet. */
const legacy = () => new Map<string, unknown>([
  ['identity', { v: 1, accountPublic: 'AAAA', accountSecret: 'BBBB', devicePublic: 'CCCC', deviceSecret: 'DDDD', cert: { accountKey: 'a' } }],
  ['prekeys', [{ publicKey: 'AQ', secretKey: 'Ag', created: 1 }]],
])

async function fresh(data: Map<string, unknown>) {
  vi.stubGlobal('indexedDB', fakeIndexedDb(data))
  vi.resetModules()
  return import('./storage')
}

describe('secrets at rest', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('encrypts a legacy store on open and still reads it', async () => {
    const data = legacy()
    const storage = await fresh(data)
    expect(await storage.openVault()).toEqual({ state: 'open' })
    expect(isSealed(data.get('identity'))).toBe(true)
    expect(isSealed(data.get('prekeys'))).toBe(true)
    expect(data.get('vault-migrated')).toBe(1)
    expect((await storage.loadPrekeys())[0].created).toBe(1)
  })

  it('refuses a secret stored in the clear after the migration, instead of returning it', async () => {
    // Security review L15: getSecret returned unsealed values for every slot, even after the migration.
    const data = legacy()
    let storage = await fresh(data)
    await storage.openVault()
    // Someone else with write access to the app's storage swaps in their own keys, unencrypted.
    data.set('prekeys', [{ publicKey: 'AQ', secretKey: 'planted', created: 2 }])
    await expect(storage.loadPrekeys()).rejects.toThrow(storage.UnsealedSecretError)
    // Also on the next start (the migration already ran, so it isn't redone over the planted value).
    storage = await fresh(data)
    expect(await storage.openVault()).toEqual({ state: 'open' })
    await expect(storage.loadPrekeys()).rejects.toThrow(/won't use it/)
    expect(data.get('prekeys')).toEqual([{ publicKey: 'AQ', secretKey: 'planted', created: 2 }])
    // Slots the migration didn't know about are refused too.
    data.set('e2ee:chains', { planted: true })
    await expect(storage.loadE2ee('chains')).rejects.toThrow(storage.UnsealedSecretError)
  })

  it("doesn't hand out a legacy secret while locked", async () => {
    const storage = await fresh(legacy())
    await expect(storage.loadPrekeys()).rejects.toThrow('Iskra is locked.')
  })
})
