// Live captions, off the main thread: each incoming voice arrives here as 16 kHz audio over its own port, Silero VAD
// cuts it into phrases, and Whisper (ONNX Runtime, WebAssembly) turns one phrase at a time into text. The text only
// goes back to the page that asked; nothing is stored or sent anywhere.
import * as ort from 'onnxruntime-web/wasm'
import { parseOnnxWeights, SileroVad } from '../audio/silero'
import { CaptionQueue, cleanCaption, FRAME, SpeechSegmenter } from './segments'
import { looksLikeSpeech, Whisper, type CaptionLanguage } from './whisper'
import { sameOriginOnly } from '../localOnly'

sameOriginOnly()

interface Voice {
  vad: SileroVad
  segmenter: SpeechSegmenter
  port: MessagePort
  frame: Float32Array
  filled: number
}

type Incoming =
  | {
    type: 'init'; ortWasm: ArrayBuffer; encoder: Uint8Array; decoder: Uint8Array; vocab: Record<string, number>
    config: Record<string, unknown>; silero: ArrayBuffer; language: CaptionLanguage | 'auto'
  }
  | { type: 'language'; language: CaptionLanguage | 'auto' }
  | { type: 'voice'; id: string; port: MessagePort }
  | { type: 'drop'; id: string }

const post = (m: unknown) => (self as unknown as Worker).postMessage(m)

let whisper: Whisper | null = null
let sileroWeights: ReturnType<typeof parseOnnxWeights> | null = null
let language: CaptionLanguage | 'auto' = 'auto'
const voices = new Map<string, Voice>()
const queue = new CaptionQueue()
let busy = false
let wasPaused = false
let audioSeconds = 0
let spentMs = 0

self.onmessage = async (e: MessageEvent<Incoming>) => {
  const m = e.data
  if (m.type === 'init') {
    try {
      language = m.language
      sileroWeights = parseOnnxWeights(m.silero)
      ort.env.wasm.wasmBinary = m.ortWasm
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      whisper = await Whisper.create(ort, { encoder: m.encoder, decoder: m.decoder, vocab: m.vocab, config: m.config })
      post({ type: 'ready' })
    } catch (err) {
      post({ type: 'error', message: (err as Error)?.message ?? String(err) })
    }
  } else if (m.type === 'language') {
    language = m.language
  } else if (m.type === 'voice') {
    addVoice(m.id, m.port)
  } else if (m.type === 'drop') {
    dropVoice(m.id)
  }
}

function addVoice(id: string, port: MessagePort): void {
  dropVoice(id)
  if (!sileroWeights) return
  const voice: Voice = { vad: new SileroVad(sileroWeights), segmenter: new SpeechSegmenter(), port, frame: new Float32Array(FRAME), filled: 0 }
  voices.set(id, voice)
  port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (voices.get(id) === voice) take(id, voice, e.data)
  }
}

function dropVoice(id: string): void {
  const voice = voices.get(id)
  if (!voice) return
  voice.port.onmessage = null
  voice.port.close()
  voices.delete(id)
  queue.drop(id)
  post({ type: 'speaking', id, on: false })
}

/** 16 kHz audio from one voice, in any sizes. */
function take(id: string, voice: Voice, samples: Float32Array): void {
  for (let i = 0; i < samples.length;) {
    const n = Math.min(FRAME - voice.filled, samples.length - i)
    voice.frame.set(samples.subarray(i, i + n), voice.filled)
    voice.filled += n
    i += n
    if (voice.filled < FRAME) break
    voice.filled = 0
    const was = voice.segmenter.speaking
    const phrase = voice.segmenter.push(voice.frame, voice.vad.process(voice.frame))
    if (voice.segmenter.speaking !== was) post({ type: 'speaking', id, on: voice.segmenter.speaking })
    if (phrase) {
      queue.add({ voice: id, audio: phrase, at: Date.now() }, Date.now())
      void work()
    }
  }
}

async function work(): Promise<void> {
  if (busy || !whisper) return
  busy = true
  try {
    for (;;) {
      const now = Date.now()
      const paused = queue.paused(now)
      if (paused !== wasPaused) {
        wasPaused = paused
        post({ type: 'status', slow: paused })
        if (paused) {
          console.warn(`[iskra] captions can't keep up here (${queue.skipped} phrases skipped); pausing them`)
          setTimeout(() => void work(), queue.pausedUntil - now + 10)
        }
      }
      const phrase = queue.next(now)
      if (!phrase) break
      const started = performance.now()
      const result = await whisper.transcribe(phrase.audio, language)
      const ms = performance.now() - started
      const seconds = phrase.audio.length / 16000
      audioSeconds += seconds
      spentMs += ms
      queue.done(ms, Date.now())
      post({ type: 'load', ms, seconds, rtf: spentMs / 1000 / audioSeconds, encoderMs: result.ms.encoder })
      const text = cleanCaption(result.text)
      if (text && looksLikeSpeech(result) && voices.has(phrase.voice)) {
        post({ type: 'caption', id: phrase.voice, text, language: result.language })
      }
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error)?.message ?? String(err) })
  } finally {
    busy = false
  }
}
