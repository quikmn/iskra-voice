// How transparent the voice chain is: runs the e2e speech fixture (clean, with fan and keyboard noise, and quiet)
// through the real chain code (DeepFilterNet3, input volume, Silero VAD gate, the listener's leveling) and prints
// the measurements (src/state/audio/quality.ts) as a Markdown table. Run from client/:
//   node scripts/audio-quality.mjs                    the chain as it is (AI noise removal at "Normal")
//   node scripts/audio-quality.mjs 12 24 100          DeepFilterNet at these attenuation limits (dB)
//   node scripts/audio-quality.mjs --before <dir>     how it was: libDF's own thresholds, no limit, and the
//                                                      vadGate.ts and leveler.ts found in <dir> (from git history)
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const file = (path) => {
  const b = readFileSync(new URL(path, import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const q = await vite.ssrLoadModule('/src/state/audio/quality.ts')
  const { DF_STRENGTH_DB } = await vite.ssrLoadModule('/src/state/audio/strength.ts')
  const args = process.argv.slice(2)
  const beforeDir = args[0] === '--before' ? args[1] : null
  const impl = beforeDir
    ? {
        VadGate: (await vite.ssrLoadModule('/@fs/' + resolve(beforeDir, 'vadGate.ts').replaceAll('\\', '/'))).VadGate,
        Leveler: (await vite.ssrLoadModule('/@fs/' + resolve(beforeDir, 'leveler.ts').replaceAll('\\', '/'))).Leveler,
      }
    : undefined
  const engines = q.loadEngines(file('../vendor/deepfilternet/deepfilter.wasm'), file('../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz.bin'), file('../vendor/silero-vad/silero_vad_16k_op15.onnx'))
  const fixture = q.readWav(file('../e2e/fixtures/speech.wav'))
  const clean = q.upsample(fixture.pcm, q.RATE / fixture.rate)
  const noise = q.mix(q.pinkNoise(clean.length, -42), q.keyboard(clean.length, q.RATE, -16))
  const noisy = q.mix(clean, noise)
  const quiet = q.mix(q.gain(clean, -20), q.pinkNoise(clean.length, -72, 7))
  const quietRef = q.gain(clean, -20)

  const limits = beforeDir ? [] : args.map(Number).filter(Number.isFinite)
  const atten = limits.length ? limits : [beforeDir ? 100 : DF_STRENGTH_DB.normal]
  const rows = []
  const row = (name, ref, input, opts, which, noisyIn) => {
    const r = q.measure(ref, q.runChain(input, engines, { ...opts, impl, legacyThresholds: !!beforeDir }), which, noisyIn)
    rows.push([name, r])
  }
  for (const a of atten) {
    const tag = atten.length > 1 || limits.length ? ` (DFN ${a} dB)` : ''
    row(`Clean: noise removal only${tag}`, clean, clean, { deepFilter: a, gate: false, leveler: false }, 'sent')
    row(`Noisy: noise removal only${tag}`, clean, noisy, { deepFilter: a, gate: false, leveler: false }, 'sent', noisy)
    row(`Clean: full chain${tag}`, clean, clean, { deepFilter: a, gate: true, leveler: true }, 'heard')
    row(`Noisy: full chain${tag}`, clean, noisy, { deepFilter: a, gate: true, leveler: true }, 'heard', noisy)
    row(`Quiet talker: full chain${tag}`, quietRef, quiet, { deepFilter: a, gate: true, leveler: true }, 'heard')
  }
  if (!limits.length) {
    row('Clean: voice gate only', clean, clean, { deepFilter: null, gate: true, leveler: false }, 'sent')
    row('Clean: leveling only', clean, clean, { deepFilter: null, gate: false, leveler: true }, 'heard')
  }

  const f = (x, d = 1) => (x === undefined ? '–' : Math.abs(x) > 99 ? (x > 0 ? '> 99' : '< -99') : x.toFixed(d))
  console.log('| Input → stage | SI-SDR dB | Log-spectral dist. dB | Speech level dB (median / dips) | Gain motion dB per 10 ms (RMS / max) | Audio dropped while talking, ms | Gate changes (speech cut, ms) | Clipped | Noise removed dB | Latency ms |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  for (const [name, r] of rows) {
    console.log(`| ${name} | ${f(r.sdr)} | ${f(r.lsd)} | ${f(r.speechGainDb)} / ${f(r.speechDipDb)} | ${f(r.gainRms, 2)} / ${f(r.gainMax)} | ${r.timingMs.toFixed(0)} | ${r.transitions} (${r.speechCutMs}) | ${r.clipped} | ${f(r.noiseReductionDb)} | ${r.latencyMs.toFixed(0)} |`)
  }
} finally {
  await vite.close()
}
