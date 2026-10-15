// Translation models on this device. They aren't part of the app: each one is downloaded once, when you first need
// it, from your own Iskra server (GET /models/translate/..., which fetched it once from Mozilla), with a members-only
// link. Every part is checked against the SHA-256 in models.json (shared with the server) before it's used or kept,
// unpacked (gzip), checked again, and kept in Cache Storage (IndexedDB where it can't), whichever server it came from.
import { checkedPart, joinParts, ModelError, openModelStore, sha256Hex, type ModelPart, type ModelStore } from '../models'
import type { PairFiles } from './engine'
import { PINS, pinFor, type ModelPin } from './languages'

const STORE = 'iskra-translate-models'
const KEY_BASE = 'https://models.iskra.invalid/models/translate'

/** Where to get models: a server's address and the member's signed query (translate.models.link). */
export interface TranslateSource {
  base: string
  path: string
  query: string
}

const partName = (file: string, i: number) => `${file}.part${i}.bin`

/** The parts of one of a model's files on a server (`source` null: only their keys, for what's kept). */
export function modelParts(pin: ModelPin, file: ModelPin['files'][number], source: TranslateSource | null): ModelPart[] {
  return file.parts.map((p, i) => ({
    url: source ? `${source.base}${source.path}/${pin.dir}/${partName(file.name, i)}?${source.query}` : `${KEY_BASE}/${pin.dir}/${partName(file.name, i)}`,
    sha256: p.sha256,
    bytes: p.bytes,
  }))
}

/** Kept under one address whichever server and link it came from. */
const keyOf = (p: ModelPart) => KEY_BASE + p.url.slice(p.url.lastIndexOf('/translate-')).split('?')[0]

let pruned = false
async function store(): Promise<ModelStore | null> {
  const s = await openModelStore(STORE)
  if (s && !pruned) {
    pruned = true
    // Drops models an older version of the app pinned.
    const keep = new Set(PINS.flatMap((pin) => pin.files.flatMap((f) => modelParts(pin, f, null).map(keyOf))))
    void s.keys().then(async (keys) => {
      for (const key of keys) if (!keep.has(key)) await s.remove(key).catch(() => undefined)
    }).catch(() => undefined)
  }
  return s
}

/** The models of `names` that are already on this device. */
export async function cachedModels(names: string[]): Promise<string[]> {
  const s = await store()
  if (!s) return []
  try {
    const keys = new Set(await s.keys())
    return names.filter((name) => {
      const pin = pinFor(name)
      return !!pin && pin.files.every((f) => modelParts(pin, f, null).every((p) => keys.has(keyOf(p))))
    })
  } catch {
    return []
  }
}

/** Unpacks gzip (the browser's own DecompressionStream). */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice().buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** One file of a model: its parts (checked), joined, unpacked and checked again. */
async function file(pin: ModelPin, f: ModelPin['files'][number], source: TranslateSource | null, s: ModelStore | null, onBytes: (n: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const parts = modelParts(pin, f, source ?? { base: 'https://not-offered.invalid', path: '/models/translate', query: '' })
  const packed = joinParts(await Promise.all(parts.map((p) => checkedPart(p, s, onBytes, signal, keyOf))))
  let unpacked: Uint8Array
  try {
    unpacked = await gunzip(packed)
  } catch {
    throw new ModelError('corrupt', `${pin.name} ${f.name} doesn't unpack`)
  }
  if (unpacked.length !== f.unpacked.bytes || (await sha256Hex(unpacked)) !== f.unpacked.sha256) throw new ModelError('corrupt', `${pin.name} ${f.name} isn't the expected file`)
  return unpacked
}

/**
 * The model `name`, ready for the engine: from this device when it's here, otherwise from `source` (null: the
 * servers don't offer it, which only matters if it isn't here). `onBytes` counts what arrives (or comes from the cache).
 */
export async function loadModel(name: string, source: TranslateSource | null, onBytes: (n: number) => void, signal?: AbortSignal): Promise<PairFiles> {
  const pin = pinFor(name)
  if (!pin) throw new ModelError('notOffered', `no model ${name}`)
  const s = await store()
  const of = (kind: string) => pin.files.find((f) => f.name.startsWith(kind))!
  try {
    const [model, lex, vocab] = await Promise.all(['model', 'lex', 'vocab'].map((kind) => file(pin, of(kind), source, s, onBytes, signal)))
    return { model, lex, vocab }
  } catch (e) {
    if (!source && e instanceof ModelError && e.kind === 'download') throw new ModelError('notOffered', name)
    throw e
  }
}
