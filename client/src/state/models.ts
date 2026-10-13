// The on-device models.
// Background effects: MediaPipe and the Selfie Segmenter are bundled with the app (about 12 MB, no CDN).
// Live captions: Whisper base (78 MB) isn't bundled or in git. It's downloaded once, when you turn captions on, from
// the Iskra server of the call you're in (GET /models/..., which fetched it once from Hugging Face), so members'
// devices only ever talk to their own server; only members get it (the app asks for a short-lived link over its
// connection first). Every part is checked against the SHA-256 compiled in below (model.json, shared with the server)
// before it's used or kept, then kept in Cache Storage (IndexedDB where Cache Storage can't, as on the desktop app's
// app://), whichever server it came from. No audio or text goes anywhere.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import visionLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url'
import visionWasmUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url'
import segmenterUrl from '../../vendor/mediapipe/selfie_segmenter.tflite?url'
import manifest from './captions/model.json'
import type { CaptionModelLink } from '../core/protocol'

/** Background effects: MediaPipe fetches these itself from the app (the browser's cache keeps them). */
export const BLUR_FILES = { loader: visionLoaderUrl, wasm: visionWasmUrl, model: segmenterUrl }

/** Whisper base's shape (from its config.json). */
export const WHISPER_CONFIG = { decoder_attention_heads: 8, d_model: 512, decoder_layers: 6, vocab_size: 51865 }

/** ONNX Runtime's WebAssembly, bundled with the app. */
const RUNTIME = { url: ortWasmUrl, bytes: 14_239_897 }

export interface ModelPart {
  url: string
  sha256: string
  bytes: number
}

/** Where to get the model: a server's address (e.g. https://chat.example.org) and the member's link to it. */
export interface CaptionSource {
  base: string
  /** The signed query from captions.model.link ("a=…&exp=…&sig=…"). */
  query: string
}

/** The model's parts on a server. */
export function captionParts(source: CaptionSource): Record<'encoder' | 'decoder' | 'vocab', ModelPart[]> {
  const query = source.query ? `?${source.query}` : ''
  const parts = (name: string) => {
    const file = manifest.files.find((f) => f.name === name)!
    return file.parts.map((p, i) => ({ url: `${source.base}/models/${manifest.dir}/${name}.part${i}.bin${query}`, sha256: p.sha256, bytes: p.bytes }))
  }
  return { encoder: parts('encoder.q8.onnx'), decoder: parts('decoder.q8.onnx'), vocab: parts('vocab.json') }
}

const MODEL_BYTES = manifest.files.reduce((n, f) => n + f.bytes, 0)

/** For the parts' names only. */
const ANY: CaptionSource = { base: 'https://any', query: '' }

/** What turning captions on downloads from the server the first time. */
export const captionDownloadBytes = () => MODEL_BYTES

/** Kept under one address whichever server (and link) it came from (a key only: nothing is ever fetched from it). */
const keyOf = (p: ModelPart) => `https://models.iskra.invalid${p.url.slice(p.url.lastIndexOf('/models/')).split('?')[0]}`

export type ModelErrorKind = 'download' | 'corrupt' | 'cancelled' | 'notOffered'

export class ModelError extends Error {
  readonly kind: ModelErrorKind
  constructor(kind: ModelErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

// ── Keeping it ───────────────────────────────────────────────────────────

const CACHE = 'iskra-models'

interface Store {
  get(url: string): Promise<Uint8Array | null>
  put(url: string, data: Uint8Array): Promise<void>
  keys(): Promise<string[]>
  remove(url: string): Promise<void>
}

function cacheStore(cache: Cache): Store {
  return {
    get: async (url) => {
      const hit = await cache.match(url)
      return hit ? new Uint8Array(await hit.arrayBuffer()) : null
    },
    put: (url, data) => cache.put(url, new Response(data.slice(), { headers: { 'content-type': 'application/octet-stream' } })),
    keys: async () => (await cache.keys()).map((r) => r.url),
    remove: async (url) => void (await cache.delete(url)),
  }
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function idbStore(): Promise<Store> {
  const open = indexedDB.open(CACHE, 1)
  open.onupgradeneeded = () => open.result.createObjectStore('parts')
  const db = await request(open)
  const tx = (mode: IDBTransactionMode) => db.transaction('parts', mode).objectStore('parts')
  return {
    get: async (url) => {
      const value = await request(tx('readonly').get(url))
      return value instanceof ArrayBuffer ? new Uint8Array(value) : null
    },
    put: async (url, data) => void (await request(tx('readwrite').put(data.slice().buffer, url))),
    keys: async () => (await request(tx('readonly').getAllKeys())).map(String),
    remove: async (url) => void (await request(tx('readwrite').delete(url))),
  }
}

let store: Promise<Store | null> | null = null
/** Cache Storage where it takes the model's https:// addresses; IndexedDB otherwise; nothing in a locked-down browser. */
function openStore(): Promise<Store | null> {
  store ??= (async () => {
    try {
      if (typeof caches === 'undefined') throw new Error('no Cache Storage')
      const cache = await caches.open(CACHE)
      // app:// and capacitor:// pages may not be able to keep anything here: find out before trusting it.
      const probe = 'https://models.iskra.invalid/.probe'
      await cache.put(probe, new Response('ok'))
      await cache.delete(probe)
      return cacheStore(cache)
    } catch {
      try {
        return typeof indexedDB === 'undefined' ? null : await idbStore()
      } catch {
        return null
      }
    }
  })()
  return store
}

let pruned = false
/** Drops models an older version of the app left behind. */
async function prune(s: Store): Promise<void> {
  if (pruned) return
  pruned = true
  const keep = new Set(Object.values(captionParts(ANY)).flat().map(keyOf))
  for (const url of await s.keys()) if (!keep.has(url)) await s.remove(url).catch(() => undefined)
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data.slice().buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Reads a response body, reporting bytes as they arrive. */
async function body(response: Response, onBytes: (n: number) => void): Promise<Uint8Array> {
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer())
    onBytes(data.length)
    return data
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    length += value.length
    onBytes(value.length)
  }
  const data = new Uint8Array(length)
  let o = 0
  for (const c of chunks) {
    data.set(c, o)
    o += c.length
  }
  return data
}

/** One checked part: from the store when it's there (and still right), otherwise downloaded, checked and kept. */
async function part(p: ModelPart, s: Store | null, onBytes: (n: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const kept = await s?.get(keyOf(p)).catch(() => null)
  if (kept && (await sha256Hex(kept)) === p.sha256) {
    onBytes(kept.length)
    return kept
  }
  let response: Response
  try {
    response = await fetch(p.url, { signal, cache: 'no-store' })
  } catch (e) {
    if (signal?.aborted) throw new ModelError('cancelled', 'cancelled')
    throw new ModelError('download', `${p.url}: ${(e as Error).message}`)
  }
  if (response.status === 404) throw new ModelError('notOffered', `${p.url}: 404`)
  if (!response.ok) throw new ModelError('download', `${p.url}: ${response.status}`)
  let data: Uint8Array
  try {
    data = await body(response, onBytes)
  } catch (e) {
    if (signal?.aborted) throw new ModelError('cancelled', 'cancelled')
    throw new ModelError('download', `${p.url}: ${(e as Error).message}`)
  }
  if (data.length !== p.bytes || (await sha256Hex(data)) !== p.sha256) throw new ModelError('corrupt', `${p.url} isn't the expected file`)
  await s?.put(keyOf(p), data).catch(() => undefined)
  return data
}

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export interface CaptionModel {
  runtime: Uint8Array
  encoder: Uint8Array
  decoder: Uint8Array
  vocab: Uint8Array
}

/** The runtime and the checked model from `source`, calling `onProgress` with the share done so far (0–1). */
export async function loadCaptionModel(source: CaptionSource, onProgress?: (done: number) => void, signal?: AbortSignal): Promise<CaptionModel> {
  const s = await openStore()
  if (s) void prune(s).catch(() => undefined)
  const files = captionParts(source)
  const total = MODEL_BYTES + RUNTIME.bytes
  let received = 0
  const onBytes = (n: number) => {
    received += n
    onProgress?.(Math.min(1, received / total))
  }
  const runtime = (async () => {
    const response = await fetch(RUNTIME.url, { signal }).catch(() => {
      throw new ModelError(signal?.aborted ? 'cancelled' : 'download', 'runtime')
    })
    if (!response.ok) throw new ModelError('download', `runtime: ${response.status}`)
    return body(response, onBytes)
  })()
  const one = async (list: ModelPart[]) => join(await Promise.all(list.map((p) => part(p, s, onBytes, signal))))
  const [encoder, decoder, vocab, wasm] = await Promise.all([one(files.encoder), one(files.decoder), one(files.vocab), runtime])
  return { runtime: wasm, encoder, decoder, vocab }
}

/** Whether the model is already on this device (turning captions on won't download it). */
export async function captionModelCached(): Promise<boolean> {
  const s = await openStore()
  if (!s) return false
  try {
    const keys = new Set(await s.keys())
    return Object.values(captionParts(ANY)).flat().every((p) => keys.has(keyOf(p)))
  } catch {
    return false
  }
}

/**
 * Whether server `base` offers the model, and the member's link to it: `ask` is the server's answer to
 * captions.model.link (only members get one; the server fetches nothing for it).
 */
export async function captionSource(base: string, ask: () => Promise<CaptionModelLink>): Promise<CaptionSource | 'no' | 'unreachable'> {
  try {
    const link = await ask()
    return link.offered ? { base, query: link.query } : 'no'
  } catch {
    return 'unreachable'
  }
}
