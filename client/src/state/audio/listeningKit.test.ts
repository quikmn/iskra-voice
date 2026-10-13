// The listening kit renders what calls do: its chain must stay the app's chain. These tests fail when the app's
// settings, choices or processors change in a way the kit doesn't follow.
import { AudioPresets } from 'livekit-client'
import { describe, expect, it } from 'vitest'
import { df_process_frame } from '../../../vendor/deepfilternet/deepfilter.js'
import { captureOptions, DEFAULT_AUDIO, type AiStrength } from '../audio'
import { pickEngine } from './engines'
import { queueDelay } from './dfQueue'
import { Framer } from './framer'
import { Leveler } from './leveler'
import {
  captureGroups, deepFilterStage, KIT_CONDITIONS, KIT_OPUS, listenerStage, loadKit, micGateStage, micStage, rnnoiseProcessor, render,
} from './listeningKit'
import { gateParams } from './micParams'
import { readWav, runChain, loadEngines, RATE, upsample, rmsDb } from './quality'
import { createDeepFilter, DF_STRENGTH_DB, warmUp } from './strength'

const fs = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fs)) as { readFileSync(path: URL, enc?: string): Uint8Array & string }
const file = (path: string) => {
  const b = readFileSync(new URL(path, import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const files = {
  deepFilterWasm: file('../../../vendor/deepfilternet/deepfilter.wasm'),
  deepFilterModel: file('../../../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz.bin'),
  sileroModel: file('../../../vendor/silero-vad/silero_vad_16k_op15.onnx'),
  rnnoiseWasm: file('../../../node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise_simd.wasm'),
}
const engines = await loadKit(files)
const fixture = readWav(file('../../../e2e/fixtures/speech.wav'))
const speech = upsample(fixture.pcm, RATE / fixture.rate).slice(0, 4 * RATE)
const cond = (id: string) => KIT_CONDITIONS.find((c) => c.id === id)!

describe('listening kit: the app\'s configuration', () => {
  it('has the six settings, each the defaults with that noise suppression', () => {
    expect(KIT_CONDITIONS.map((c) => c.id)).toEqual(['off', 'standard', 'strong', 'ai-gentle', 'ai-normal', 'ai-max'])
    const strengths = KIT_CONDITIONS.filter((c) => c.engine === 'ai').map((c) => c.settings.aiStrength)
    expect(strengths.sort()).toEqual((Object.keys(DF_STRENGTH_DB) as AiStrength[]).sort())
    for (const c of KIT_CONDITIONS) expect(c.settings).toEqual({ ...DEFAULT_AUDIO, noise: c.settings.noise, aiStrength: c.settings.aiStrength })
  })

  it('takes the engine, capture options, strength and mic parameters from the app', () => {
    const caps = { worklet: true, simd: true }
    const healthy = { aiBroken: false, aiSlow: false, rnnoiseBroken: false }
    expect(KIT_CONDITIONS.map((c) => c.engine)).toEqual(['off', 'browser', 'rnnoise', 'ai', 'ai', 'ai'])
    for (const c of KIT_CONDITIONS) {
      const engine = pickEngine(c.settings.noise, caps, healthy)
      expect(c.engine).toBe(engine)
      const { deviceId: _, ...capture } = captureOptions(c.settings, engine)
      expect(c.capture).toEqual(capture)
      expect(c.deepFilterDb).toBe(engine === 'ai' ? DF_STRENGTH_DB[c.settings.aiStrength] : null)
      expect(c.mic).toEqual(gateParams(c.settings, false))
      expect(c.leveling).toBe(DEFAULT_AUDIO.leveling)
    }
    // Off and Standard get the browser's automatic gain, Standard its noise suppression; ours run without either.
    expect(captureGroups().map((g) => g.ids)).toEqual([['off'], ['standard'], ['strong', 'ai-gentle', 'ai-normal', 'ai-max']])
  })

  it('uses what the app uses: the mic parameters, RNNoise\'s worklet, Opus at LiveKit\'s default bitrate', () => {
    const pipeline = source('../micPipeline.ts')
    expect(pipeline).toContain("import { gateParams } from './audio/micParams'")
    expect(pipeline).toContain("'@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'")
    expect(source('./listeningKit.ts')).toContain("import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js')")
    expect(source('./assets.ts')).toContain('rnnoise_simd.wasm')
    expect(KIT_OPUS.bitrate).toBe(AudioPresets.music.maxBitrate)
    expect(source('../voice.ts')).toMatch(/publishDefaults: \{[^}]*dtx: true, red: true \}/)
    expect(DEFAULT_AUDIO.cleanIncoming).toBe(false) // the kit's listener stage renders this default
  })
})

describe('listening kit: the app\'s processors', { timeout: 60000 }, () => {
  it('the mic stage is the mic worklet: the same as the quality harness, sample for sample', () => {
    const kit = micGateStage(speech, cond('off'), engines.sileroModel)
    const harness = runChain(speech, loadEngines(files.deepFilterWasm, files.deepFilterModel, files.sileroModel), { deepFilter: null, gate: true, leveler: false }).sent
    expect(kit.length).toBe(harness.length)
    let diff = 0
    for (let i = 0; i < kit.length; i++) if (kit[i] !== harness[i]) diff++
    expect(diff).toBe(0)
    expect(rmsDb(kit)).toBeGreaterThan(rmsDb(speech) - 3) // it opened
  })

  it('DeepFilterNet runs as the worker runs it, at the worklet queue\'s delay', () => {
    const db = DF_STRENGTH_DB.normal
    const out = deepFilterStage(speech, db, engines.deepFilterModel)
    const state = createDeepFilter(new Uint8Array(files.deepFilterModel), db)
    warmUp(state, df_process_frame)
    const framer = new Framer(480, RATE, (f) => df_process_frame(state, f))
    const ref = new Float32Array(speech.length)
    const block = new Float32Array(128)
    for (let k = 0; k + 128 <= speech.length; k += 128) {
      framer.push(speech.subarray(k, k + 128), block)
      ref.set(block, k)
    }
    const shift = queueDelay(512) - framer.latency
    let diff = 0
    for (let i = shift; i < out.length; i++) if (out[i] !== ref[i - shift]) diff++
    expect(diff).toBe(0)
  })

  it('the listener stage is the leveler worklet', () => {
    const out = listenerStage(speech, cond('ai-normal'))
    const leveler = new Leveler(RATE)
    const ref = new Float32Array(out.length)
    const o = new Float32Array(128)
    for (let k = 0; k + 128 <= speech.length; k += 128) {
      leveler.process(speech.subarray(k, k + 128), o)
      ref.set(o, k)
    }
    expect(out).toEqual(ref)
  })

  it('RNNoise runs from the library\'s own worklet', async () => {
    const out = render(await rnnoiseProcessor(files.rnnoiseWasm), speech)
    expect(rmsDb(out)).toBeGreaterThan(rmsDb(speech) - 6)
    expect(out).not.toEqual(speech.subarray(0, out.length))
    const sent = await micStage(speech, cond('strong'), engines)
    expect(sent.length).toBe(out.length)
  })
})
