// Realtime factors of the voice processing, on this machine (time spent / length of audio processed; 0.05 = 5% of
// one core), and what DeepFilterNet costs the audio thread per render call. Run from client/: node scripts/bench-audio.mjs
// Uses the bundled engines and the e2e speech fixture with noise added. Browsers run the same WebAssembly and
// JavaScript, usually a little slower than Node; phones several times slower.
import { readFileSync } from 'node:fs'
import { df_create, df_process_frame, df_set_thresholds, initSync } from '../vendor/deepfilternet/deepfilter.js'
import { parseOnnxWeights, SileroVad } from '../src/state/audio/silero.ts'
import { Leveler } from '../src/state/audio/leveler.ts'
import { VadGate } from '../src/state/audio/vadGate.ts'

const file = (path) => readFileSync(new URL(path, import.meta.url))

function wav16k(path) {
  const b = file(path)
  let o = 12
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4)
    const size = b.readUInt32LE(o + 4)
    if (id === 'data') {
      const pcm = new Float32Array(size / 2)
      for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(o + 8 + i * 2) / 32768
      return pcm
    }
    o += 8 + size
  }
  throw new Error('no data')
}

const speech16 = wav16k('../e2e/fixtures/speech.wav')
// 48 kHz with a noise floor, as a mic would give it.
let seed = 1
const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1
const speech48 = new Float32Array(speech16.length * 3)
for (let i = 0; i < speech48.length; i++) {
  const p = i / 3
  const a = Math.floor(p)
  speech48[i] = speech16[a] + ((speech16[a + 1] ?? 0) - speech16[a]) * (p - a) + 0.02 * noise()
}
const seconds = speech48.length / 48000

function bench(name, run) {
  run() // warm up
  const t = performance.now()
  const rounds = 3
  for (let r = 0; r < rounds; r++) run()
  const rtf = (performance.now() - t) / 1000 / (seconds * rounds)
  console.log(`${name.padEnd(42)} realtime factor ${rtf.toFixed(4)}  (${(rtf * 100).toFixed(2)}% of one core)`)
  return rtf
}

// DeepFilterNet3: 480-sample frames at 48 kHz.
initSync({ module: file('../vendor/deepfilternet/deepfilter.wasm') })
let t = performance.now()
const state = df_create(new Uint8Array(file('../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz.bin')), 30) // Normal
df_set_thresholds(state, -15, 35, 35)
console.log(`DeepFilterNet3 start-up: ${(performance.now() - t).toFixed(0)} ms`)
bench('DeepFilterNet3 (mic or one incoming voice)', () => {
  for (let i = 0; i + 480 <= speech48.length; i += 480) df_process_frame(state, speech48.subarray(i, i + 480))
})

// Silero VAD: 512-sample frames at 16 kHz.
const vad = new SileroVad(parseOnnxWeights(file('../vendor/silero-vad/silero_vad_16k_op15.onnx').buffer.slice(0)))
bench('Silero VAD', () => {
  for (let i = 0; i + 512 <= speech16.length; i += 512) vad.process(speech16.subarray(i, i + 512))
})

// Leveling and the VAD gate: 128-sample blocks at 48 kHz.
const leveler = new Leveler(48000)
const gate = new VadGate(48000)
const out = new Float32Array(128)
bench('Leveling (one incoming voice)', () => {
  for (let i = 0; i + 128 <= speech48.length; i += 128) leveler.process(speech48.subarray(i, i + 128), out)
})
bench('Voice activity gate', () => {
  for (let i = 0; i + 128 <= speech48.length; i += 128) {
    gate.setProbability(i % 3 ? 0.9 : 0.1)
    gate.process(speech48.subarray(i, i + 128), out)
  }
})

// The audio thread's share of DeepFilterNet: time per 128-sample render call (2.67 ms of audio), with the network
// inside the call (the framer, as it used to run) and off it (the queue: the worker processes frames between calls).
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]
const summary = (times) => {
  times.sort((a, b) => a - b)
  const mean = times.reduce((a, b) => a + b, 0) / times.length
  return `mean ${(mean * 1000).toFixed(1)} µs, p99 ${(pct(times, 0.99) * 1000).toFixed(1)} µs, max ${(times[times.length - 1] * 1000).toFixed(0)} µs`
}
function renderCalls(name, step, between = () => {}) {
  const times = []
  const out = new Float32Array(128)
  for (let i = 0; i + 128 <= speech48.length; i += 128) {
    const t0 = performance.now()
    step(speech48.subarray(i, i + 128), out)
    times.push(performance.now() - t0)
    between(i / 128)
  }
  console.log(`${name.padEnd(42)} per render call: ${summary(times)} (budget 2667 µs)`)
}
const { Framer } = await import('../src/state/audio/framer.ts')
const { FrameQueue, queueDelay } = await import('../src/state/audio/dfQueue.ts')
const { createDeepFilter, warmUp } = await import('../src/state/audio/strength.ts')
const fresh = () => {
  const st = createDeepFilter(new Uint8Array(file('../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz.bin')), 30)
  warmUp(st, df_process_frame)
  return st
}
const inThread = fresh()
const framer = new Framer(480, 48000, (frame) => df_process_frame(inThread, frame))
renderCalls('Audio thread, DeepFilterNet in the call', (block, o) => framer.push(block, o))

const offThread = fresh()
const queue = new FrameQueue(queueDelay(512))
const waiting = []
const workerTimes = []
queue.attach({
  send: (index, frame) => (waiting.push([index, frame.slice()]), true),
  poll: () => {},
})
renderCalls('Audio thread, DeepFilterNet in a worker', (block, o) => queue.process(block, o), (k) => {
  // "The worker", after every fourth render call (a 10 ms device buffer), not on the audio thread's clock.
  if (k % 4 !== 3) return
  for (const [index, frame] of waiting.splice(0)) {
    const t0 = performance.now()
    frame.set(df_process_frame(offThread, frame))
    workerTimes.push(performance.now() - t0)
    queue.take(index, frame)
  }
})
console.log(`${'Worker, DeepFilterNet per 10 ms frame'.padEnd(42)} ${summary(workerTimes)} (overruns ${queue.overruns})`)
