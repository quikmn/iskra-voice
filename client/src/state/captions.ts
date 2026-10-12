// Live captions in calls, on this device only: opt in per listener ("Show captions"). Each incoming voice (and your
// own, if you ask for it) is tapped in an AudioContext of its own, turned into 16 kHz audio and sent to the captions
// worker, where Silero VAD finds the phrases and Whisper transcribes them. The text is shown under each speaker's
// name and forgotten a few seconds later: never sent to the server, never stored. The model (78 MB) isn't part of the
// app: the first time, you're asked before it's downloaded from the server of the call (models.ts), and it's kept on
// the device after that.
import { RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication, type Room } from 'livekit-client'
import { create } from 'zustand'
import tapWorkletUrl from './captions/tap.worklet.ts?worker&url'
import { loadSilero } from './audio/assets'
import { keepRunning } from './micPipeline'
import { engineCaps } from './audio/engines'
import { CAPTION_TTL_MS, rollCaption } from './captions/segments'
import type { CaptionLanguage } from './captions/whisper'
import { captionModelCached, captionsOffered, loadCaptionModel, ModelError, WHISPER_CONFIG } from './models'
import { useApp } from './store'
import { activeRoom, cleanedAudio, onIncomingAudio, useVoice } from './voice'

export type CaptionChoice = CaptionLanguage | 'auto'

export interface CaptionSettings {
  enabled: boolean
  language: CaptionChoice
  /** Caption your own voice too. */
  includeSelf: boolean
}

export interface CaptionLine {
  text: string
  /** When the last words came (ms). */
  at: number
  /** Talking right now (a caption is on its way). */
  speaking: boolean
}

export type CaptionStatus =
  | 'off'
  /** The model isn't on this device yet: waiting for you to say yes to the download. */
  | 'needsDownload'
  | 'loading'
  | 'ready'
  | 'slow'
  /** The download failed (offline, or the host didn't answer). */
  | 'downloadFailed'
  /** What arrived wasn't the model this app expects (its SHA-256 didn't match). */
  | 'corrupt'
  /** The call's server doesn't offer the model (its owner turned it off). */
  | 'notOffered'
  | 'error'
  | 'unsupported'

interface CaptionsState {
  settings: CaptionSettings
  status: CaptionStatus
  /** Download progress while loading (0–1). */
  progress: number
  /** The model is already on this device. */
  cached: boolean
  /** Captions by speaker (account key). */
  lines: Record<string, CaptionLine>
}

const KEY = 'iskra.captions'
const DEFAULTS: CaptionSettings = { enabled: false, language: 'auto', includeSelf: false }


export function parseCaptionSettings(raw: string | null): CaptionSettings {
  try {
    const parsed = JSON.parse(raw ?? '{}') as Partial<CaptionSettings>
    return {
      enabled: parsed.enabled === true,
      language: parsed.language === 'en' || parsed.language === 'sv' ? parsed.language : 'auto',
      includeSelf: parsed.includeSelf === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function load(): CaptionSettings {
  try {
    return parseCaptionSettings(localStorage.getItem(KEY))
  } catch {
    return { ...DEFAULTS }
  }
}

export const useCaptions = create<CaptionsState>(() => ({ settings: load(), status: 'off', progress: 0, cached: false, lines: {} }))

/** Captions need AudioWorklet, workers and WebAssembly with SIMD (ONNX Runtime is built with it). */
export const captionsSupported = () => engineCaps().worklet && engineCaps().simd && typeof Worker === 'function'

export function updateCaptions(patch: Partial<CaptionSettings>): void {
  const settings = { ...useCaptions.getState().settings, ...patch }
  useCaptions.setState({ settings })
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* private mode: this session only */
  }
  if (patch.language) worker?.postMessage({ type: 'language', language: settings.language })
  sync()
}

export function refreshCaptionCache(): void {
  void captionModelCached().then((cached) => useCaptions.setState({ cached }))
}

// ── Running ──────────────────────────────────────────────────────────────

interface Tap {
  source: MediaStreamTrack
  input: MediaStreamAudioSourceNode
  node: AudioWorkletNode
}

let worker: Worker | null = null
let ctx: AudioContext | null = null
let sink: GainNode | null = null
let room: Room | null = null
let starting: Promise<void> | null = null
let generation = 0
const taps = new Map<string, Tap>()
let unsubscribe: (() => void)[] = []
let sweeper: ReturnType<typeof setInterval> | null = null
let stopResuming: (() => void) | null = null
let download: AbortController | null = null
/** You said yes to downloading the model (this session). */
let approved = false

/** Yes, download the model (or try again after it failed). */
export function approveCaptionDownload(): void {
  approved = true
  room = null
  sync()
}

/** Stop the download and turn captions off. */
export function cancelCaptionDownload(): void {
  updateCaptions({ enabled: false })
}

/** Starts or stops captions to match the setting and the call. */
function sync(): void {
  const { session } = useVoice.getState()
  const want = useCaptions.getState().settings.enabled && session?.state === 'connected' && !!activeRoom()
  if (want && activeRoom() !== room) {
    stop()
    if (!captionsSupported()) {
      useCaptions.setState({ status: 'unsupported' })
      return
    }
    starting = start(activeRoom()!)
  } else if (!want && (room || worker)) {
    stop()
  } else if (!want) {
    useCaptions.setState({ status: 'off' })
  }
}

useVoice.subscribe((s, prev) => {
  if (s.session?.state !== prev.session?.state || s.session !== prev.session) sync()
})

async function start(current: Room): Promise<void> {
  const mine = ++generation
  const began = performance.now()
  room = current
  // The model comes from the server this call runs on (DM and group calls too).
  const base = useApp.getState().servers[useVoice.getState().session?.serverKey ?? '']?.url ?? ''
  const cached = await captionModelCached()
  if (mine !== generation) return
  useCaptions.setState({ cached })
  if (!cached) {
    const offered = await captionsOffered(base)
    if (mine !== generation) return
    if (offered === 'no') {
      useCaptions.setState({ status: 'notOffered', progress: 0, lines: {} })
      return
    }
    if (!approved) {
      useCaptions.setState({ status: 'needsDownload', progress: 0, lines: {} })
      return
    }
  }
  useCaptions.setState({ status: 'loading', progress: 0, lines: {} })
  download = new AbortController()
  try {
    const [files, silero] = await Promise.all([loadCaptionModel(base, (progress) => useCaptions.setState({ progress }), download.signal), loadSilero()])
    download = null
    if (mine !== generation) return
    useCaptions.setState({ cached: true })
    const next = new Worker(new URL('./captions/captions.worker.ts', import.meta.url), { type: 'module' })
    const ready = new Promise<void>((resolve, reject) => {
      next.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
        if (e.data.type === 'ready') resolve()
        else if (e.data.type === 'error') reject(new Error(e.data.message))
      }
      next.onerror = (e) => reject(new Error(e.message || 'captions worker failed'))
    })
    const vocab = JSON.parse(new TextDecoder().decode(files.vocab)) as Record<string, number>
    next.postMessage({
      type: 'init', ortWasm: files.runtime.buffer, encoder: files.encoder, decoder: files.decoder, vocab, config: WHISPER_CONFIG,
      silero: silero.slice(0), language: useCaptions.getState().settings.language,
    }, [files.runtime.buffer, files.encoder.buffer, files.decoder.buffer])
    worker = next
    await ready
    if (mine !== generation) return
    next.onmessage = onWorker
    next.onerror = () => useCaptions.setState({ status: 'error' })
    ctx = new AudioContext({ latencyHint: 'playback' })
    stopResuming = keepRunning(ctx)
    await ctx.audioWorklet.addModule(tapWorkletUrl)
    if (mine !== generation) return
    sink = ctx.createGain()
    sink.gain.value = 0
    sink.connect(ctx.destination)
    useCaptions.setState({ status: 'ready' })
    console.info(`[iskra] captions ready in ${Math.round(performance.now() - began)} ms`)
    watchRoom(current)
    sweeper = setInterval(sweep, 1000)
  } catch (e) {
    if (mine !== generation) return
    console.warn('[iskra] captions could not start', e)
    // The call goes on as it is; captions wait for "Try again" (no new download on their own).
    stop()
    room = current
    const kind = e instanceof ModelError ? e.kind : null
    useCaptions.setState({ status: kind === 'download' ? 'downloadFailed' : kind === 'corrupt' ? 'corrupt' : kind === 'notOffered' ? 'notOffered' : 'error' })
  }
}

function stop(): void {
  generation++
  starting = null
  download?.abort()
  download = null
  for (const id of [...taps.keys()]) untap(id)
  for (const off of unsubscribe) off()
  unsubscribe = []
  if (sweeper) clearInterval(sweeper)
  sweeper = null
  worker?.terminate()
  worker = null
  stopResuming?.()
  stopResuming = null
  void ctx?.close().catch(() => undefined)
  ctx = null
  sink = null
  room = null
  useCaptions.setState({ status: 'off', progress: 0, lines: {} })
}

/** Taps everyone's mic as they come and go (and yours, if you want that). */
function watchRoom(current: Room): void {
  const refresh = () => {
    if (room !== current) return
    const wanted = new Map<string, MediaStreamTrack>()
    current.remoteParticipants.forEach((p: RemoteParticipant) => {
      const pub = p.getTrackPublication(Track.Source.Microphone) as RemoteTrackPublication | undefined
      const track = pub?.track as RemoteTrack | undefined
      if (!pub?.isSubscribed || !track?.mediaStreamTrack) return
      // With "Clean up others' audio" on, caption the cleaned voice.
      wanted.set(p.identity, (track.sid && cleanedAudio(track.sid)) || track.mediaStreamTrack)
    })
    const own = current.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack
    if (useCaptions.getState().settings.includeSelf && own) wanted.set(current.localParticipant.identity, own)
    for (const [id, tap] of taps) if (wanted.get(id) !== tap.source) untap(id)
    for (const [id, source] of wanted) if (!taps.has(id)) addTap(id, source)
  }
  const events = [RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.ParticipantDisconnected, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished] as const
  for (const event of events) current.on(event, refresh)
  unsubscribe.push(() => events.forEach((event) => current.off(event, refresh)))
  unsubscribe.push(onIncomingAudio(refresh))
  unsubscribe.push(useCaptions.subscribe((s, prev) => s.settings.includeSelf !== prev.settings.includeSelf && refresh()))
  refresh()
}

function addTap(id: string, source: MediaStreamTrack): void {
  if (!ctx || !sink || !worker) return
  try {
    const input = ctx.createMediaStreamSource(new MediaStream([source]))
    const node = new AudioWorkletNode(ctx, 'iskra-caption-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    const channel = new MessageChannel()
    worker.postMessage({ type: 'voice', id, port: channel.port2 }, [channel.port2])
    node.port.postMessage({ port: channel.port1 }, [channel.port1])
    input.connect(node).connect(sink)
    taps.set(id, { source, input, node })
  } catch (e) {
    console.warn('[iskra] captions: could not listen to a voice', e)
  }
}

function untap(id: string): void {
  const tap = taps.get(id)
  if (!tap) return
  taps.delete(id)
  tap.input.disconnect()
  tap.node.disconnect()
  tap.node.port.postMessage('stop')
  worker?.postMessage({ type: 'drop', id })
}

type WorkerMessage =
  | { type: 'caption'; id: string; text: string }
  | { type: 'speaking'; id: string; on: boolean }
  | { type: 'status'; slow: boolean }
  | { type: 'load'; ms: number; seconds: number; rtf: number; encoderMs: number }
  | { type: 'error'; message: string }

let lastLog = 0
function onWorker(e: MessageEvent<WorkerMessage>): void {
  const m = e.data
  if (m.type === 'caption') {
    useCaptions.setState((s) => {
      const previous = s.lines[m.id]
      const fresh = previous && Date.now() - previous.at < CAPTION_TTL_MS
      return { lines: { ...s.lines, [m.id]: { text: rollCaption(fresh ? previous.text : '', m.text), at: Date.now(), speaking: previous?.speaking ?? false } } }
    })
  } else if (m.type === 'speaking') {
    useCaptions.setState((s) => {
      const previous = s.lines[m.id]
      if (!previous && !m.on) return s
      return { lines: { ...s.lines, [m.id]: { text: previous?.text ?? '', at: previous?.at ?? Date.now(), speaking: m.on } } }
    })
  } else if (m.type === 'status') {
    useCaptions.setState({ status: m.slow ? 'slow' : 'ready' })
  } else if (m.type === 'load') {
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now()
      console.info(`[iskra] captions: ${m.seconds.toFixed(1)} s phrase in ${Math.round(m.ms)} ms (encoder ${Math.round(m.encoderMs)} ms), realtime factor ${m.rtf.toFixed(2)}`)
    }
  } else if (m.type === 'error') {
    console.warn('[iskra] captions', m.message)
  }
}

/** Captions fade a few seconds after someone's last words. */
function sweep(): void {
  const now = Date.now()
  const { lines } = useCaptions.getState()
  const stale = Object.entries(lines).filter(([, l]) => !l.speaking && now - l.at > CAPTION_TTL_MS)
  if (!stale.length) return
  const next = { ...lines }
  for (const [id] of stale) delete next[id]
  useCaptions.setState({ lines: next })
}

/** For tests: wait until captions have started (or failed). */
export const captionsStarting = () => starting
