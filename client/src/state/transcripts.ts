// Voice message transcripts, on this device only: "Show transcript" on a voice message (or "Transcribe voice messages
// automatically") runs the live captions' Whisper model (captions.worker.ts) over the recording. The model comes from
// your own server once, after you say yes, and is kept (models.ts); the recording is decoded here and never sent
// anywhere, and neither is the text. Transcripts are kept on the device (transcripts/transcriptCache.ts): channel ones
// in IndexedDB, encrypted ones in memory only. English and Swedish, like captions (Settings → Voice & audio →
// Captions → Language). A device too slow for it gets a "too slow" note, and automatic transcripts stop there.
import { useEffect } from 'react'
import { errorFields, log } from '../core/log'
import { create } from 'zustand'
import { captionsSupported, useCaptions } from './captions'
import { findWhisperSource, startWhisperWorker } from './captions/whisperHost'
import type { CaptionLanguage } from './captions/whisper'
import { captionModelCached, ModelError } from './models'
import { diskCache, forgetTranscripts, isEncryptedKey, memoryCache, type TranscriptCache } from './transcripts/transcriptCache'

export type TranscriptStatus =
  /** The speech model isn't on this device: waiting for a yes to the download. */
  | 'needsDownload'
  | 'loading'
  | 'working'
  | 'done'
  /** No speech was heard. */
  | 'empty'
  /** This device took too long. */
  | 'tooSlow'
  | 'failed'
  | 'notOffered'
  | 'downloadFailed'
  | 'corrupt'
  | 'unsupported'

export interface TranscriptEntry {
  status: TranscriptStatus
  text?: string
  /** Shown under the player (false: made automatically and nothing to show, or hidden again). */
  shown: boolean
}

/** One voice message to transcribe. */
export interface TranscriptItem {
  /** transcriptKey.file(…) or transcriptKey.encrypted(…). */
  key: string
  /** The server whose model to use (the message's own). */
  serverKey: string
  /** The recording's bytes (fetched, or decrypted here). */
  audio: () => Promise<ArrayBuffer>
  durationMs: number
}

interface TranscriptsState {
  entries: Record<string, TranscriptEntry>
  /** "Transcribe voice messages automatically" (off by default). */
  auto: boolean
  /** This device was too slow once: no more automatic transcripts here (asking still works). */
  slow: boolean
  /** Model download or loading progress (0–1) while a transcript waits for it. */
  progress: number
}

const KEY = 'iskra.transcripts'

function load(): { auto: boolean; slow: boolean } {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { auto?: unknown; slow?: unknown }
    return { auto: parsed.auto === true, slow: parsed.slow === true }
  } catch {
    return { auto: false, slow: false }
  }
}

export const useTranscripts = create<TranscriptsState>(() => ({ entries: {}, ...load(), progress: 0 }))

function saveSettings(patch: Partial<Pick<TranscriptsState, 'auto' | 'slow'>>): void {
  useTranscripts.setState(patch)
  const { auto, slow } = useTranscripts.getState()
  try {
    localStorage.setItem(KEY, JSON.stringify({ auto, slow }))
  } catch {
    /* private mode: this session only */
  }
}

/** Turning it on again also gives a device that was too slow another go. */
export const setAutoTranscribe = (on: boolean) => saveSettings(on ? { auto: true, slow: false } : { auto: false })

const setEntry = (key: string, patch: Partial<TranscriptEntry>) =>
  useTranscripts.setState((s) => ({ entries: { ...s.entries, [key]: { ...(s.entries[key] ?? { shown: false }), ...patch } as TranscriptEntry } }))

// ── Keeping them ─────────────────────────────────────────────────────────

const memory = memoryCache()
let disk: TranscriptCache | null = null
/** Encrypted recordings' transcripts never touch the disk. */
export function cacheFor(key: string): TranscriptCache {
  if (isEncryptedKey(key)) return memory
  disk ??= typeof indexedDB === 'undefined' ? memory : diskCache()
  return disk
}

export { forgetTranscripts }

// ── Audio ────────────────────────────────────────────────────────────────

/** The recording as 16 kHz mono (what Whisper hears), decoded by the browser. */
export async function decodeTo16k(bytes: ArrayBuffer): Promise<Float32Array> {
  const decoder = new OfflineAudioContext(1, 16000, 16000)
  const buffer = await decoder.decodeAudioData(bytes.slice(0))
  if (buffer.sampleRate === 16000 && buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice()
  // Some browsers keep the file's own rate: render it down.
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * 16000)), 16000)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start()
  return (await ctx.startRendering()).getChannelData(0).slice()
}

// ── The worker ───────────────────────────────────────────────────────────

/** Stopped this long after the last transcript, to give its memory back. */
const IDLE_MS = 2 * 60_000
/** Longer than this (or this slow) counts as too slow for this device. */
const tooLongMs = (durationMs: number) => Math.max(60_000, durationMs * 4 + 30_000)
const SLOW_FACTOR = 1.5

let worker: Worker | null = null
let starting: Promise<Worker> | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let download: AbortController | null = null
let jobs = 0
const pending = new Map<number, { resolve: (r: { text: string; ms: number; seconds: number }) => void; reject: (e: Error) => void }>()
/** You said yes to the model download (this session; once downloaded it's kept). */
let approved = false
/** Waiting for that yes. */
const waiting = new Map<string, TranscriptItem>()

class NeedsDownload extends Error {}
class NotOffered extends Error {}
class TooSlow extends Error {}

function stopWorker(): void {
  worker?.terminate()
  worker = null
  starting = null
  if (idle) clearTimeout(idle)
  idle = null
  for (const job of pending.values()) job.reject(new Error('stopped'))
  pending.clear()
}

function onWorker(e: MessageEvent<{ type: string; job?: number; text?: string; ms?: number; seconds?: number; message?: string }>): void {
  const m = e.data
  if (m.type !== 'transcript' && m.type !== 'transcriptFailed') return
  const job = pending.get(m.job!)
  if (!job) return
  pending.delete(m.job!)
  if (m.type === 'transcript') job.resolve({ text: m.text ?? '', ms: m.ms ?? 0, seconds: m.seconds ?? 0 })
  else job.reject(new Error(m.message ?? 'transcript failed'))
}

async function workerFor(serverKey: string): Promise<Worker> {
  if (worker) return worker
  starting ??= (async () => {
    const found = await findWhisperSource(serverKey)
    if (!found.cached) {
      if (found.offered === 'no') throw new NotOffered()
      if (!approved) throw new NeedsDownload()
    }
    useTranscripts.setState({ progress: 0 })
    download = new AbortController()
    const next = await startWhisperWorker(found.source, 'auto', (progress) => useTranscripts.setState({ progress }), download.signal)
    download = null
    next.onmessage = onWorker
    next.onerror = () => stopWorker()
    worker = next
    return next
  })()
  starting.catch(() => (starting = null))
  return starting
}

function run16k(w: Worker, audio: Float32Array, language: CaptionLanguage | 'auto', timeoutMs: number) {
  if (idle) clearTimeout(idle)
  const job = ++jobs
  return new Promise<{ text: string; ms: number; seconds: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(job)
      reject(new TooSlow())
    }, timeoutMs)
    pending.set(job, {
      resolve: (r) => {
        clearTimeout(timer)
        resolve(r)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    w.postMessage({ type: 'transcribe', job, audio, language }, [audio.buffer])
  }).finally(() => {
    if (pending.size === 0) {
      if (idle) clearTimeout(idle)
      idle = setTimeout(stopWorker, IDLE_MS)
    }
  })
}

/** Tests (dev builds only): a stand-in for Whisper, given the decoded 16 kHz audio. */
type TestTranscriber = (audio: Float32Array) => string | Promise<string>
const testTranscriber = (): TestTranscriber | null =>
  import.meta.env.DEV ? ((window as unknown as { __iskraTestTranscriber?: TestTranscriber }).__iskraTestTranscriber ?? null) : null

// ── Transcribing ─────────────────────────────────────────────────────────

/** Running now, by key (one run per message at a time). */
const running = new Set<string>()

async function run(item: TranscriptItem, auto: boolean): Promise<void> {
  if (running.has(item.key)) return
  running.add(item.key)
  const show = !auto
  const shownNow = () => useTranscripts.getState().entries[item.key]?.shown ?? show
  try {
    const kept = await cacheFor(item.key).get(item.key)
    if (kept) return setEntry(item.key, { status: kept.text ? 'done' : 'empty', text: kept.text, shown: shownNow() })
    const fake = testTranscriber()
    if (!fake && !captionsSupported()) return setEntry(item.key, { status: 'unsupported', shown: show })
    setEntry(item.key, { status: 'working', shown: shownNow() })
    let text: string
    if (fake) {
      text = (await fake(await decodeTo16k(await item.audio()))).trim()
    } else {
      // Automatic ones never ask the server or for a download by themselves: only once the model is here or approved.
      if (auto && !approved && !worker && !(await captionModelCached())) {
        waiting.set(item.key, item)
        return setEntry(item.key, { status: 'needsDownload', shown: shownNow() })
      }
      // The model first (asks for the download if needed), then the recording.
      if (!worker) setEntry(item.key, { status: 'loading' })
      let w: Worker
      try {
        w = await workerFor(item.serverKey)
      } catch (e) {
        if (e instanceof NeedsDownload) {
          waiting.set(item.key, item)
          return setEntry(item.key, { status: 'needsDownload', shown: shownNow() })
        }
        throw e
      }
      setEntry(item.key, { status: 'working' })
      const audio = await decodeTo16k(await item.audio())
      const result = await run16k(w, audio, useCaptions.getState().settings.language, tooLongMs(item.durationMs))
      if (result.seconds > 5 && result.ms > result.seconds * 1000 * SLOW_FACTOR) saveSettings({ slow: true })
      text = result.text.trim()
    }
    await cacheFor(item.key).put(item.key, { text, at: Date.now() })
    setEntry(item.key, { status: text ? 'done' : 'empty', text })
  } catch (e) {
    if (e instanceof TooSlow) {
      console.warn('[iskra] transcript: this device is too slow for it')
      log('WARN', 'media', 'failed', 'MED-150', [['what', 'transcript'], ['why', 'slow']])
      stopWorker()
      saveSettings({ slow: true })
      return setEntry(item.key, { status: 'tooSlow', shown: true })
    }
    console.warn('[iskra] transcript failed', e)
    const kind = e instanceof NotOffered ? 'notOffered' : e instanceof ModelError ? e.kind : null
    log('WARN', 'media', 'failed', 'MED-150', [['what', 'transcript'], ['why', kind ?? undefined], ...errorFields(e)])
    const status: TranscriptStatus = kind === 'notOffered' ? 'notOffered' : kind === 'download' ? 'downloadFailed' : kind === 'corrupt' ? 'corrupt' : 'failed'
    setEntry(item.key, { status, shown: shownNow() || !auto })
  } finally {
    running.delete(item.key)
  }
}

/** "Show transcript" (again after hiding it: the text is kept). */
export function showTranscript(item: TranscriptItem): void {
  const entry = useTranscripts.getState().entries[item.key]
  if (entry && ['done', 'empty', 'working', 'loading'].includes(entry.status)) return setEntry(item.key, { shown: true })
  setEntry(item.key, { shown: true })
  void run(item, false)
}

export function hideTranscript(key: string): void {
  setEntry(key, { shown: false })
}

/** Yes to the model download: every transcript waiting for it goes on. */
export function approveTranscriptDownload(): void {
  approved = true
  for (const [key, item] of [...waiting]) {
    waiting.delete(key)
    const entry = useTranscripts.getState().entries[key]
    void run(item, !entry?.shown)
  }
}

/** Stops a model download in progress. */
export function cancelTranscriptDownload(): void {
  download?.abort()
  download = null
}

/** For the player: its transcript, made by itself when automatic transcripts are on (and the model is here or approved). */
export function useVoiceTranscript(item: TranscriptItem | null): TranscriptEntry | undefined {
  const entry = useTranscripts((s) => (item ? s.entries[item.key] : undefined))
  const auto = useTranscripts((s) => s.auto && !s.slow)
  const has = !!entry
  useEffect(() => {
    if (item && auto && !has) void run(item, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.key, auto, has])
  return entry
}

/** For tests: forget the worker and every answer. */
export function resetTranscripts(): void {
  stopWorker()
  approved = false
  waiting.clear()
  running.clear()
  useTranscripts.setState({ entries: {}, progress: 0 })
}
