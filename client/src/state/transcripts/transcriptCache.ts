// Where voice message transcripts are kept on this device. Channel voice messages: IndexedDB (the recording is on the
// server unencrypted anyway), keyed by server and file id, the oldest dropped past MAX_KEPT. End-to-end encrypted
// ones (DMs, group DMs, encrypted channels): memory only, gone when the app closes, never written to disk in the clear.
// Transcripts are never uploaded anywhere.

import { slotDbName } from '../../core/accountSlot'

export interface KeptTranscript {
  text: string
  /** When it was made (ms). */
  at: number
}

export interface TranscriptCache {
  get(key: string): Promise<KeptTranscript | null>
  put(key: string, value: KeptTranscript): Promise<void>
}

export const MAX_KEPT = 2000
export const MAX_TEXT = 20_000

/** "f:<serverKey>:<fileId>" for a channel voice message, "e:<serverKey>:<fileId>" for an encrypted one. */
export const transcriptKey = {
  file: (serverKey: string, fileId: string) => `f:${serverKey}:${fileId}`,
  encrypted: (serverKey: string, fileId: string) => `e:${serverKey}:${fileId}`,
}

export const isEncryptedKey = (key: string) => key.startsWith('e:')

export function memoryCache(max = MAX_KEPT): TranscriptCache {
  const kept = new Map<string, KeptTranscript>()
  return {
    get: async (key) => kept.get(key) ?? null,
    put: async (key, value) => {
      kept.delete(key)
      kept.set(key, { text: value.text.slice(0, MAX_TEXT), at: value.at })
      while (kept.size > max) kept.delete(kept.keys().next().value!)
    },
  }
}

/** Per account on this device (core/accountSlot.ts). */
export const DB_NAME = 'iskra-transcripts'
const dbName = () => slotDbName(DB_NAME)

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

let db: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> {
  db ??= (async () => {
    const req = indexedDB.open(dbName(), 1)
    req.onupgradeneeded = () => req.result.createObjectStore('texts').createIndex('at', 'at')
    return request(req)
  })()
  db.catch(() => (db = null))
  return db
}

/** IndexedDB, falling back to nothing (a locked-down browser): transcripts are then made again when asked. */
export function diskCache(max = MAX_KEPT): TranscriptCache {
  const store = async (mode: IDBTransactionMode) => (await open()).transaction('texts', mode).objectStore('texts')
  return {
    get: async (key) => {
      try {
        const value = await request((await store('readonly')).get(key)) as KeptTranscript | undefined
        return value && typeof value.text === 'string' ? value : null
      } catch {
        return null
      }
    },
    put: async (key, value) => {
      try {
        const texts = await store('readwrite')
        await request(texts.put({ text: value.text.slice(0, MAX_TEXT), at: value.at }, key))
        const count = await request(texts.count())
        if (count <= max) return
        // Drop the oldest few past the limit.
        const cursor = texts.index('at').openKeyCursor()
        let left = count - max
        await new Promise<void>((resolve) => {
          cursor.onsuccess = () => {
            const c = cursor.result
            if (!c || left-- <= 0) return resolve()
            texts.delete(c.primaryKey)
            c.continue()
          }
          cursor.onerror = () => resolve()
        })
      } catch {
        /* not kept: made again next time */
      }
    },
  }
}

/** Forgets every kept transcript (signing out). */
export async function forgetTranscripts(): Promise<void> {
  try {
    const open = await db?.catch(() => null)
    open?.close()
    db = null
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(dbName())
      r.onsuccess = r.onerror = r.onblocked = () => resolve()
    })
  } catch {
    /* nothing kept */
  }
}
