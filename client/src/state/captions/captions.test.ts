import { describe, expect, it } from 'vitest'
import * as ort from 'onnxruntime-web'
import { CaptionQueue, cleanCaption, FRAME, rollCaption, SpeechSegmenter, MAX_CAPTION_CHARS } from './segments'
import { FRAMES, logMel, melFilters, N_MELS } from './mel'
import { looksLikeSpeech, repeating, Vocabulary, Whisper } from './whisper'
import { parseCaptionSettings } from '../captions'
import { parseOnnxWeights, SileroVad } from '../audio/silero'

// Node's fs, without pulling Node's types into the app's type check.
const fs = 'node:fs'
const { readFileSync, existsSync } = (await import(/* @vite-ignore */ fs)) as { readFileSync(path: URL): Uint8Array; existsSync(path: URL): boolean }

const vendor = (path: string) => readFileSync(new URL(`../../../vendor/${path}`, import.meta.url))
// The captions model isn't in git: `node scripts/get-models.mjs` puts it here.
const MODEL = new URL('../../../.models/models/whisper-base-1846881b/', import.meta.url)
const haveModel = existsSync(new URL('decoder.q8.onnx.part2.bin', MODEL))
const model = (name: string) => readFileSync(new URL(name, MODEL))
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))

function speech(): Float32Array {
  const b = readFileSync(new URL('../../../e2e/fixtures/speech.wav', import.meta.url))
  const v = view(b)
  let o = 12
  while (o < b.length) {
    const size = v.getUint32(o + 4, true)
    if (ascii(b, o, o + 4) === 'data') {
      const pcm = new Float32Array(size / 2)
      for (let i = 0; i < pcm.length; i++) pcm[i] = v.getInt16(o + 8 + i * 2, true) / 32768
      return pcm
    }
    o += 8 + size
  }
  throw new Error('no data')
}

const frame = (value = 0) => new Float32Array(FRAME).fill(value)

describe('speech segmenter', () => {
  it('cuts a phrase between speech and the hangover, with pre-roll', () => {
    const s = new SpeechSegmenter({ preRollMs: 64, hangoverMs: 160, minSpeechMs: 0 })
    for (let i = 0; i < 10; i++) expect(s.push(frame(0.01), 0.1)).toBeNull()
    expect(s.speaking).toBe(false)
    for (let i = 0; i < 20; i++) expect(s.push(frame(0.5), 0.9)).toBeNull()
    expect(s.speaking).toBe(true)
    let phrase: Float32Array | null = null
    for (let i = 0; i < 10 && !phrase; i++) phrase = s.push(frame(0.01), 0.1)
    expect(phrase).not.toBeNull()
    expect(s.speaking).toBe(false)
    // Pre-roll (2–3 frames) + 20 speech frames + up to 100 ms of the quiet after it.
    const frames = phrase!.length / FRAME
    expect(frames).toBeGreaterThanOrEqual(22)
    expect(frames).toBeLessThanOrEqual(26)
    expect(phrase![phrase!.length - 1]).toBeCloseTo(0.01)
  })

  it('stays in the phrase through short pauses', () => {
    const s = new SpeechSegmenter({ hangoverMs: 500, minSpeechMs: 0 })
    for (let i = 0; i < 10; i++) s.push(frame(), 0.9)
    for (let i = 0; i < 10; i++) expect(s.push(frame(), 0.1)).toBeNull() // 320 ms
    for (let i = 0; i < 10; i++) s.push(frame(), 0.9)
    expect(s.speaking).toBe(true)
  })

  it('drops blips that are too short to be words', () => {
    const s = new SpeechSegmenter({ hangoverMs: 64, minSpeechMs: 300 })
    s.push(frame(), 0.9)
    s.push(frame(), 0.9)
    let out: Float32Array | null = null
    for (let i = 0; i < 5; i++) out = s.push(frame(), 0.1) ?? out
    expect(out).toBeNull()
    expect(s.speaking).toBe(false)
  })

  it('cuts long talks into pieces and keeps going', () => {
    const s = new SpeechSegmenter({ maxMs: 3200, minSpeechMs: 0 })
    const phrases: Float32Array[] = []
    for (let i = 0; i < 250; i++) {
      const p = s.push(frame(), 0.9)
      if (p) phrases.push(p)
    }
    expect(phrases.length).toBe(2)
    expect(phrases[0].length / FRAME).toBe(100)
    expect(s.speaking).toBe(true)
    expect(s.flush()).not.toBeNull()
  })
})

describe('caption queue', () => {
  const phrase = (voice: string, at: number) => ({ voice, at, audio: new Float32Array(16) })

  it('hands phrases out oldest first and skips ones that got too old', () => {
    const q = new CaptionQueue({ maxLagMs: 1000, maxSkips: 10 })
    q.add(phrase('a', 0), 0)
    q.add(phrase('b', 900), 900)
    expect(q.next(1500)?.voice).toBe('b') // a waited too long
    expect(q.skipped).toBe(1)
    expect(q.next(1500)).toBeNull()
  })

  it('keeps the queue short and caps how many people are captioned at once', () => {
    const q = new CaptionQueue({ maxQueued: 2, maxSpeakers: 2, maxSkips: 10 })
    q.add(phrase('a', 0), 0)
    q.add(phrase('b', 0), 0)
    q.add(phrase('c', 0), 0) // a third person while two are waiting
    expect(q.length).toBe(2)
    q.add(phrase('a', 1), 1) // the oldest goes
    expect(q.length).toBe(2)
    expect(q.skipped).toBe(2)
  })

  it('pauses when it keeps falling behind, and comes back after a while', () => {
    const q = new CaptionQueue({ maxLagMs: 100, maxSkips: 3, windowMs: 10000, pauseMs: 5000 })
    for (let i = 0; i < 3; i++) q.add(phrase('a', i), i)
    expect(q.next(1000)).toBeNull()
    expect(q.paused(1000)).toBe(true)
    q.add(phrase('a', 1100), 1100) // ignored while paused
    expect(q.next(1200)).toBeNull()
    expect(q.paused(7000)).toBe(false)
    q.add(phrase('a', 7000), 7000)
    expect(q.next(7010)?.voice).toBe('a')
  })

  it('pauses when one transcription takes far too long, and forgets people who left', () => {
    const q = new CaptionQueue({ slowMs: 5000, pauseMs: 1000 })
    q.done(6000, 0)
    expect(q.paused(500)).toBe(true)
    q.add(phrase('a', 2000), 2000)
    q.add(phrase('b', 2000), 2000)
    q.drop('a')
    expect(q.next(2001)?.voice).toBe('b')
  })
})

describe('captions shown', () => {
  it('rolls: the newest words, cut at a word, about two lines', () => {
    expect(rollCaption('', 'Hello.')).toBe('Hello.')
    expect(rollCaption('Hello.', 'How are you?')).toBe('Hello. How are you?')
    const long = rollCaption('word '.repeat(40).trim(), 'the end.')
    expect(long.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS + 1)
    expect(long.startsWith('…word')).toBe(true)
    expect(long.endsWith('the end.')).toBe(true)
  })

  it("strips what Whisper writes for sounds it can't make out", () => {
    expect(cleanCaption('[BLANK_AUDIO]')).toBe('')
    expect(cleanCaption('(music) Hello ♪♪ there [laughs]')).toBe('Hello there')
  })

  it("drops results Whisper itself doubts, and stops runaway repeats", () => {
    expect(looksLikeSpeech({ text: 'Thank you.', noSpeech: 0.9, avgLogProb: -1.2 })).toBe(false)
    expect(looksLikeSpeech({ text: 'Hi there', noSpeech: 0.1, avgLogProb: -0.3 })).toBe(true)
    expect(looksLikeSpeech({ text: 'mumble', noSpeech: 0.1, avgLogProb: -2 })).toBe(false)
    expect(repeating([1, 2, 3, 1, 2, 3, 1, 2, 3])).toBe(true)
    expect(repeating([5, 5, 5])).toBe(false) // "no, no, no" is fine
    expect(repeating([5, 5, 5, 5, 5])).toBe(true)
    expect(repeating([1, 2, 3, 4, 5, 6])).toBe(false)
  })

  it('reads settings safely: off by default, only known languages', () => {
    expect(parseCaptionSettings(null)).toEqual({ enabled: false, language: 'auto', includeSelf: false })
    expect(parseCaptionSettings('{"enabled":true,"language":"sv","includeSelf":true}')).toEqual({ enabled: true, language: 'sv', includeSelf: true })
    expect(parseCaptionSettings('{"enabled":"yes","language":"de"}')).toEqual({ enabled: false, language: 'auto', includeSelf: false })
    expect(parseCaptionSettings('not json')).toEqual({ enabled: false, language: 'auto', includeSelf: false })
  })
})

describe('whisper features', () => {
  it('has 80 Slaney mel filters covering 0–8 kHz', () => {
    const f = melFilters()
    expect(f.length).toBe(N_MELS * 201)
    for (let m = 0; m < N_MELS; m++) expect(f.slice(m * 201, m * 201 + 201).some((v) => v > 0)).toBe(true)
    // Slaney normalisation: wider (higher) filters are lower.
    expect(Math.max(...f.slice(0, 201))).toBeGreaterThan(Math.max(...f.slice(79 * 201)))
  })

  it('pads to 30 s: silence is flat, speech is not', () => {
    const silence = logMel(new Float32Array(16000))
    expect(silence.length).toBe(N_MELS * FRAMES)
    expect(new Set(silence).size).toBe(1)
    const mel = logMel(speech())
    expect(mel.reduce((a, b) => Math.max(a, b), -Infinity)).toBeLessThanOrEqual(1.6)
    expect(mel[10 * FRAMES + 100]).not.toBe(mel[10 * FRAMES + 2900])
  })

  it('decodes byte-level tokens, skipping special ones', () => {
    const v = new Vocabulary({ Hello: 0, 'Ġw': 1, orld: 2, 'Ã¥': 3 })
    expect(v.decode([0, 1, 2, 50257, 50363])).toBe('Hello world')
    expect(v.decode([3])).toBe('å')
  })
})

describe('whisper', () => {
  it.skipIf(!haveModel)('transcribes the speech fixture, phrases found by Silero VAD (needs node scripts/get-models.mjs)', { timeout: 120_000 }, async () => {
    ort.env.wasm.numThreads = 1
    const join = (name: string, n: number) => {
      const parts = Array.from({ length: n }, (_, i) => model(`${name}.part${i}.bin`))
      const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
      parts.reduce((o, p) => (out.set(p, o), o + p.length), 0)
      return out
    }
    const whisper = await Whisper.create(ort, {
      encoder: join('encoder.q8.onnx', 2),
      decoder: join('decoder.q8.onnx', 3),
      vocab: JSON.parse(new TextDecoder().decode(model('vocab.json.part0.bin'))),
      config: { decoder_attention_heads: 8, d_model: 512, decoder_layers: 6, vocab_size: 51865 },
    })
    const audio = speech()
    const silero = vendor('silero-vad/silero_vad_16k_op15.onnx')
    const vad = new SileroVad(parseOnnxWeights(silero.buffer.slice(silero.byteOffset, silero.byteOffset + silero.byteLength) as ArrayBuffer))
    const segmenter = new SpeechSegmenter()
    let first: Float32Array | null = null
    for (let i = 0; i + FRAME <= audio.length && !first; i += FRAME) first = segmenter.push(audio.subarray(i, i + FRAME), vad.process(audio.subarray(i, i + FRAME)))
    expect(first).not.toBeNull()
    const result = await whisper.transcribe(first!, 'auto')
    expect(result.language).toBe('en')
    expect(looksLikeSpeech(result)).toBe(true)
    expect(result.text).toMatch(/Donald Trump and Sarah Palin/)
    // Forcing the language works too.
    expect((await whisper.transcribe(first!.subarray(0, 16000 * 3), 'en')).text).toMatch(/Donald/)
    await whisper.release()
  })
})
