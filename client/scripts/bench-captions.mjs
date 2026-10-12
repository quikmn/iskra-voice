// Live captions on this machine: Silero VAD cuts the e2e speech fixture into phrases, Whisper base (8-bit, ONNX
// Runtime WebAssembly, one thread, as in the app) transcribes each. Logs the time per phrase and the realtime factor
// (time spent / length of audio; above 1 means captions fall behind). Run from client/: node scripts/bench-captions.mjs [file.wav]
// Background blur runs in the browser only (MediaPipe needs it): its fps and time per frame are logged to the
// developer console while it runs, and printed by e2e/blur-captions.spec.ts.
import { readFileSync } from 'node:fs'
import * as ort from 'onnxruntime-web'
import { parseOnnxWeights, SileroVad } from '../src/state/audio/silero.ts'
import { cleanCaption, FRAME, SpeechSegmenter } from '../src/state/captions/segments.ts'
import { looksLikeSpeech, Whisper } from '../src/state/captions/whisper.ts'

const file = (path) => readFileSync(new URL(path, import.meta.url))
// The model isn't in git: node scripts/get-models.mjs (from the repo root) puts it in client/.models.
const MODEL = '../.models/models/whisper-base-1846881b'
const joined = (name, parts) => Buffer.concat(Array.from({ length: parts }, (_, i) => file(`${MODEL}/${name}.part${i}.bin`)))

function wav16k(path) {
  const b = readFileSync(path)
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

ort.env.wasm.numThreads = 1
const audio = wav16k(process.argv[2] ?? new URL('../e2e/fixtures/speech.wav', import.meta.url))
const seconds = audio.length / 16000

let t = performance.now()
const whisper = await Whisper.create(ort, {
  encoder: joined('encoder.q8.onnx', 2),
  decoder: joined('decoder.q8.onnx', 3),
  vocab: JSON.parse(file(`${MODEL}/vocab.json.part0.bin`).toString('utf8')),
  config: { decoder_attention_heads: 8, d_model: 512, decoder_layers: 6, vocab_size: 51865 },
})
console.log(`Whisper base loaded in ${Math.round(performance.now() - t)} ms`)

// Phrases, as the captions worker finds them.
const vad = new SileroVad(parseOnnxWeights(file('../vendor/silero-vad/silero_vad_16k_op15.onnx').buffer))
const segmenter = new SpeechSegmenter()
const phrases = []
t = performance.now()
for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
  const frame = audio.subarray(i, i + FRAME)
  const phrase = segmenter.push(frame, vad.process(frame))
  if (phrase) phrases.push(phrase)
}
const last = segmenter.flush()
if (last) phrases.push(last)
console.log(`Silero VAD: ${phrases.length} phrases in ${seconds.toFixed(1)} s of audio, realtime factor ${((performance.now() - t) / 1000 / seconds).toFixed(3)}`)

let spent = 0
let spoken = 0
for (const phrase of phrases) {
  const r = await whisper.transcribe(phrase, 'auto')
  const ms = r.ms.features + r.ms.encoder + r.ms.decoder
  spent += ms
  spoken += phrase.length / 16000
  const shown = looksLikeSpeech(r) ? cleanCaption(r.text) : '(dropped)'
  console.log(`${(phrase.length / 16000).toFixed(1)} s → ${Math.round(ms)} ms (features ${Math.round(r.ms.features)}, encoder ${Math.round(r.ms.encoder)}, decoder ${Math.round(r.ms.decoder)}) [${r.language}] ${shown}`)
}
console.log(`Whisper: realtime factor ${(spent / 1000 / spoken).toFixed(2)} over ${spoken.toFixed(1)} s of speech (${Math.round(spent / phrases.length)} ms per phrase)`)
