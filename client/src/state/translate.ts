// Message translation, on this device only: "Translate" on a message, or "Auto-translate messages not in my language"
// per channel, DM or group. It runs after decryption (so it works for end-to-end encrypted messages too), in a worker
// (translate/translate.worker.ts): ELD tells the language, Bergamot translates with Mozilla's models. The text is
// never sent anywhere or stored; translations live in memory until the app closes. The models come from your own
// Iskra server, once each (translate/modelFiles.ts), after you say yes to the download.
import { useEffect } from 'react'
import { errorFields, log } from '../core/log'
import { create } from 'zustand'
import wasmUrl from '../../vendor/bergamot/bergamot-translator.wasm?url'
import { currentLanguage } from '../i18n'
import { nativePlatform } from '../platform/native'
import { ModelError } from './models'
import { connectionFor, useApp } from './store'
import { modelBytes, route, TRANSLATE_LANGUAGES } from './translate/languages'
import { cachedModels, loadModel, type TranslateSource } from './translate/modelFiles'
import { TranslatorClient } from './translate/workerClient'
import type { TranslateModelsLink } from '../core/protocol'

export type TranslationStatus =
  | 'detecting'
  /** The models aren't on this device: waiting for a yes to the download (`bytes`). */
  | 'needsDownload'
  | 'downloading'
  | 'translating'
  | 'done'
  /** Already in your language. */
  | 'same'
  /** Too short or too mixed to tell the language. */
  | 'unknown'
  /** A language there are no models for (`from`). */
  | 'unsupported'
  /** None of your servers offers translation models. */
  | 'notOffered'
  /** What arrived wasn't the pinned model. */
  | 'corrupt'
  | 'failed'
  /** This browser can't run it (no WebAssembly, workers or gzip streams). */
  | 'noEngine'

export interface Translation {
  status: TranslationStatus
  from?: string
  text?: string
  /** Download progress (0–1). */
  progress?: number
  /** What the download weighs. */
  bytes?: number
  /** The models it needs that aren't on this device. */
  missing?: string[]
  /** Shown under the message (false: asked for by auto-translate and nothing to show, or "Show original"). */
  shown: boolean
}

/** One message to translate: plain text (no markup), in a conversation, with the servers that may have the models. */
export interface TranslateItem {
  /** "c:<serverKey>:<channelId>", "dm:<accountKey>", "g:<groupKey>" (see convKey). */
  conv: string
  id: string
  text: string
  servers: string[]
}

export interface TranslateSettings {
  /** The language to translate into; null: the app's language. */
  target: string | null
  /** Conversations where messages not in your language are translated as they're shown. */
  auto: string[]
}

const KEY = 'iskra.translate'
const MAX_AUTO = 500

export function parseTranslateSettings(raw: string | null): TranslateSettings {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Partial<TranslateSettings>
    return {
      target: typeof parsed.target === 'string' && TRANSLATE_LANGUAGES.includes(parsed.target) ? parsed.target : null,
      auto: Array.isArray(parsed.auto) ? parsed.auto.filter((c): c is string => typeof c === 'string' && c.length <= 200).slice(-MAX_AUTO) : [],
    }
  } catch {
    return { target: null, auto: [] }
  }
}

function load(): TranslateSettings {
  try {
    return parseTranslateSettings(localStorage.getItem(KEY))
  } catch {
    return { target: null, auto: [] }
  }
}

interface TranslateState {
  settings: TranslateSettings
  entries: Record<string, Translation>
}

export const useTranslate = create<TranslateState>(() => ({ settings: load(), entries: {} }))

function save(settings: TranslateSettings): void {
  useTranslate.setState({ settings })
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* private mode: this session only */
  }
}

/** The language messages are translated into. */
export const translateTarget = (settings = useTranslate.getState().settings): string => settings.target ?? currentLanguage()

export function setTranslateTarget(target: string | null): void {
  save({ ...useTranslate.getState().settings, target: target && TRANSLATE_LANGUAGES.includes(target) ? target : null })
}

export function setAutoTranslate(conv: string, on: boolean): void {
  const { settings } = useTranslate.getState()
  const auto = settings.auto.filter((c) => c !== conv)
  save({ ...settings, auto: on ? [...auto, conv].slice(-MAX_AUTO) : auto })
}

export const convKey = {
  channel: (serverKey: string, channelId: number) => `c:${serverKey}:${channelId}`,
  dm: (peer: string) => `dm:${peer}`,
  group: (groupKey: string) => `g:${groupKey}`,
}

function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/** One message's translation, into one language (an edited message is a new one). */
export const entryKey = (item: Pick<TranslateItem, 'conv' | 'id' | 'text'>, target = translateTarget()) => `${item.conv}|${item.id}|${target}|${hash(item.text)}`

const setEntry = (key: string, patch: Partial<Translation>) =>
  useTranslate.setState((s) => ({ entries: { ...s.entries, [key]: { ...(s.entries[key] ?? { shown: false }), ...patch } as Translation } }))

/** Phones get a word about mobile data before a download. */
export const onPhone = () => !!nativePlatform() || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)

export const translateSupported = () =>
  typeof Worker === 'function' && typeof WebAssembly === 'object' && typeof DecompressionStream === 'function'

// ── The worker ───────────────────────────────────────────────────────────

let client: TranslatorClient | null = null
let engine: Promise<void> | null = null
/** Models going into the worker, or gone in (`settled`); it keeps only a few (engine.ts MAX_LOADED). */
const loading = new Map<string, Promise<void>>()
const settled = new Set<string>()

function worker(): TranslatorClient {
  if (!client) {
    const next = new Worker(new URL('./translate/translate.worker.ts', import.meta.url), { type: 'module' })
    client = new TranslatorClient(next as unknown as ConstructorParameters<typeof TranslatorClient>[0])
    next.addEventListener('error', () => {
      client?.terminate()
      client = null
      engine = null
      loading.clear()
      settled.clear()
    })
  }
  return client
}

function startEngine(): Promise<void> {
  engine ??= (async () => {
    const response = await fetch(wasmUrl)
    if (!response.ok) throw new Error(`engine: ${response.status}`)
    await worker().init(await response.arrayBuffer())
  })()
  engine.catch(() => {
    engine = null
  })
  return engine
}

// ── Where the models come from ───────────────────────────────────────────

const links = new Map<string, { link: TranslateModelsLink; until: number }>()

async function linkFor(serverKey: string): Promise<TranslateModelsLink | null> {
  const kept = links.get(serverKey)
  if (kept && kept.until > Date.now()) return kept.link
  const connection = connectionFor(serverKey)
  if (!connection) return null
  try {
    const link = await connection.request('translate.models.link', {})
    links.set(serverKey, { link, until: link.offered ? link.expires - 60_000 : Date.now() + 60_000 })
    return link
  } catch {
    return null
  }
}

/** The first server (the conversation's own first, then any you're connected to) that offers all of `models`. */
export async function findSource(preferred: string[], models: string[]): Promise<TranslateSource | null> {
  const { servers, order } = useApp.getState()
  const candidates = [...new Set([...preferred, ...order])].filter((key) => servers[key]?.status.state === 'online')
  for (const key of candidates) {
    const link = await linkFor(key)
    if (link?.offered && models.every((m) => link.models.includes(m))) return { base: servers[key].url, path: link.path, query: link.query }
  }
  return null
}

// ── Translating ──────────────────────────────────────────────────────────

/** Models you said yes to downloading (this session; once downloaded they're kept). */
const approved = new Set<string>()
/** Waiting for a yes, by entry: what to run again. */
const waiting = new Map<string, TranslateItem>()
/** Auto-translate asks about a download once per conversation, not under every message. */
const asked = new Set<string>()

async function ensureModel(name: string, source: TranslateSource | null, onBytes: (n: number) => void): Promise<void> {
  let job = loading.get(name)
  if (!job) {
    job = (async () => {
      const files = await loadModel(name, source, onBytes)
      await worker().load(name, files)
    })()
    loading.set(name, job)
    job.then(() => settled.add(name), () => loading.delete(name))
  }
  return job
}

async function run(item: TranslateItem, auto: boolean): Promise<void> {
  const target = translateTarget()
  const key = entryKey(item, target)
  const show = !auto
  if (!translateSupported()) return setEntry(key, { status: 'noEngine', shown: show })
  setEntry(key, { status: 'detecting', shown: show })
  try {
    const detected = await worker().detect(item.text, [target, currentLanguage()])
    if (!detected.language || (auto && !detected.reliable)) return setEntry(key, { status: 'unknown', shown: show })
    const from = detected.language
    if (from === target) return setEntry(key, { status: 'same', from, shown: show })
    const models = route(from, target)
    if (!models) return setEntry(key, { status: 'unsupported', from, shown: show })
    // In the worker already (or on its way there), else on this device, else to download.
    const inWorker = new Set(engine ? await worker().has(models).catch(() => []) : [])
    for (const m of models) if (!inWorker.has(m) && settled.has(m)) {
      loading.delete(m) // the worker let it go to make room
      settled.delete(m)
    }
    const notLoaded = models.filter((m) => !inWorker.has(m) && !loading.has(m))
    const pending = models.filter((m) => !inWorker.has(m) && loading.has(m))
    const cached = new Set(await cachedModels(notLoaded))
    const missing = notLoaded.filter((m) => !cached.has(m))
    let source: TranslateSource | null = null
    if (missing.length) {
      source = await findSource(item.servers, missing)
      if (!source) return setEntry(key, { status: 'notOffered', from, shown: show || !asked.has(item.conv) })
      if (!missing.every((m) => approved.has(m))) {
        waiting.set(key, item)
        const prompt = show || !asked.has(item.conv)
        if (auto) asked.add(item.conv)
        return setEntry(key, { status: 'needsDownload', from, bytes: modelBytes(missing), missing, shown: prompt })
      }
    }
    await startEngine()
    const total = modelBytes(notLoaded) || 1
    let received = 0
    setEntry(key, { status: missing.length ? 'downloading' : 'translating', from, progress: 0, shown: true })
    const onBytes = (n: number) => {
      received += n
      if (missing.length) setEntry(key, { progress: Math.min(1, received / total) })
    }
    await Promise.all([...notLoaded, ...pending].map((m) => ensureModel(m, source, onBytes)))
    setEntry(key, { status: 'translating' })
    const text = await worker().translate(item.text, models)
    setEntry(key, { status: 'done', from, text, shown: true, progress: undefined })
  } catch (e) {
    console.warn('[iskra] translation failed', e)
    const kind = e instanceof ModelError ? e.kind : null
    log('WARN', 'media', 'failed', 'MED-150', [['what', 'translation'], ['why', kind ?? undefined], ...errorFields(e)])
    setEntry(key, { status: kind === 'notOffered' ? 'notOffered' : kind === 'corrupt' ? 'corrupt' : 'failed', shown: true })
  }
}

/** "Translate" on a message (again after "Show original": the translation is kept). */
export function translateMessage(item: TranslateItem): void {
  // Asking again looks again: an owner may just have turned translation on.
  for (const [server, kept] of links) if (!kept.link.offered) links.delete(server)
  const key = entryKey(item)
  const entry = useTranslate.getState().entries[key]
  if (entry?.status === 'done') return setEntry(key, { shown: true })
  if (entry && ['detecting', 'downloading', 'translating'].includes(entry.status)) return setEntry(key, { shown: true })
  void run(item, false)
}

/** "Show original": hides the translation (and any notice) under the message. */
export function hideTranslation(key: string): void {
  setEntry(key, { shown: false })
}

/** Yes to the download a message asks for: it and every message waiting for the same models go on. */
export function approveTranslationDownload(key: string): void {
  const entry = useTranslate.getState().entries[key]
  for (const m of entry?.missing ?? []) approved.add(m)
  for (const [k, item] of [...waiting]) {
    const e = useTranslate.getState().entries[k]
    if (e?.missing?.every((m) => approved.has(m))) {
      waiting.delete(k)
      void run(item, !e.shown && k !== key)
    }
  }
}

/** For a message row: its translation, and auto-translate when the conversation has it on. */
export function useMessageTranslation(item: TranslateItem | null): { key: string; entry: Translation | undefined } {
  const target = useTranslate((s) => translateTarget(s.settings))
  const auto = useTranslate((s) => !!item && s.settings.auto.includes(item.conv))
  const key = item ? entryKey(item, target) : ''
  const entry = useTranslate((s) => (key ? s.entries[key] : undefined))
  const has = !!entry
  useEffect(() => {
    if (item && auto && !has && item.text.trim()) void run(item, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, auto, has])
  return { key, entry }
}

/** Is auto-translate on here? */
export const useAutoTranslate = (conv: string) => useTranslate((s) => s.settings.auto.includes(conv))

/** For tests: forget the worker, links and answers. */
export function resetTranslate(): void {
  client?.terminate()
  client = null
  engine = null
  loading.clear()
  settled.clear()
  links.clear()
  approved.clear()
  waiting.clear()
  asked.clear()
  useTranslate.setState({ entries: {} })
}
