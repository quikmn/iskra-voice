// The listening kit: test clips rendered through exactly what a call does to a voice, for a blind listening test
// without a call. Voices (clean, and with keyboard, fan, café and music noise at two SNRs) go through Chromium's own
// mic capture with each setting's options, the app's noise suppression (Off, Standard, Strong = RNNoise, AI =
// DeepFilterNet3 at Gentle, Normal and Max), the mic's worklet (Silero's gate with its pre-roll, input volume,
// limiter), Opus as calls send it, and the listener's "Even out voices". The chain's configuration comes from the app
// itself (src/state/audio/listeningKit.ts; listeningKit.test.ts guards it). Writes a folder (git-ignored) with 48 kHz
// WAV files, one self-contained HTML page for blind A/B and ABX listening with a scoring sheet, a README for the
// listener and the measured numbers. Run from client/ (needs Playwright's Chromium: npx playwright install chromium):
//   node scripts/listening-kit.mjs                      everything, into .listening-kit/
//   node scripts/listening-kit.mjs --zip <file.zip>     and pack it
//   node scripts/listening-kit.mjs --only female-clean  just these inputs (comma-separated ids)
//   node scripts/listening-kit.mjs --speech me.wav      your own recordings (48 kHz mono 16-bit WAV, clean, 5-20 s)
//                                                       instead of the built-in voices (repeat for more)
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { capture, opusCodec } from './listening-kit/browser.mjs'
import { encodeFlac } from './listening-kit/flac.mjs'
import { zip } from './listening-kit/zip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = resolve(HERE, '..')
const KIT = join(HERE, 'listening-kit')

// ── Options ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []))
const OUT = resolve(opt('out', join(CLIENT, '.listening-kit')))
const ZIP = opt('zip', null)
const ONLY = opt('only', null)?.split(',')
const SNRS = (opt('snr', '15,5')).split(',').map(Number)
const JOBS = Number(opt('jobs', '4'))
/** Keeps the browser recordings (in <out>/.work) and uses them again next time: for working on the kit itself. */
const REUSE = argv.includes('--reuse')
/** Speech goes in at this active level (dBFS): a mic set up the usual way. */
const SPEECH_DB = -26
/** A quiet room and a decent mic: the floor under the clean voices (dBFS RMS, pink). */
const ROOM_DB = -66
/** Level matching in the page brings every clip's voice to this loudness (LUFS over speech). */
const TARGET_LUFS = -23

const file = (path) => {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
const toInt16 = (x) => Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))))
const fromInt16 = (x) => Float32Array.from(x, (v) => v / 32768)
const log = (...a) => console.log(...a)

const vite = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const q = await vite.ssrLoadModule('/src/state/audio/quality.ts')
  const kit = await vite.ssrLoadModule('/src/state/audio/listeningKit.ts')
  const RATE = kit.KIT_RATE
  const engines = await kit.loadKit({
    deepFilterWasm: file(join(CLIENT, 'vendor/deepfilternet/deepfilter.wasm')),
    deepFilterModel: file(join(CLIENT, 'vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz.bin')),
    sileroModel: file(join(CLIENT, 'vendor/silero-vad/silero_vad_16k_op15.onnx')),
    rnnoiseWasm: file(join(CLIENT, 'node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise_simd.wasm')),
  })
  const conditions = kit.KIT_CONDITIONS
  const groups = kit.captureGroups(conditions)

  // ── Inputs ─────────────────────────────────────────────────────────────
  const sources = JSON.parse(readFileSync(join(KIT, 'sources.json'), 'utf8'))
  const readMono = (path) => {
    const w = q.readWav(file(path))
    if (w.rate !== RATE) throw new Error(`${path}: needs 48 kHz (it's ${w.rate} Hz)`)
    return w.pcm
  }
  const own = all('speech')
  const voices = own.length
    ? own.map((path, i) => ({ id: `voice${i + 1}`, label: basename(path, '.wav'), text: [], credit: `Your recording: ${basename(path)}`, pcm: readMono(path) }))
    : sources.speech.map((s) => ({ id: basename(s.file, '.wav').replace('speech-', ''), label: s.label, text: s.text, credit: `${s.source}. ${s.authors}. ${s.url}. Licence: ${s.license}. Changes: ${s.changes}.`, pcm: readMono(join(KIT, s.file)) }))
  for (const v of voices) {
    // Whole render calls, then the level a mic would give.
    v.pcm = kit.scale(v.pcm.subarray(0, Math.floor(v.pcm.length / 128) * 128), SPEECH_DB - kit.activeLevelDb(v.pcm))
    v.phrases = kit.phrasesOf(v.pcm)
  }
  const noises = sources.noise.map((n) => ({ ...n, credit: `${n.source}. ${n.url}. Licence: ${n.license}. Changes: ${n.changes}.`, pcm: readMono(join(KIT, n.file)) }))

  const inputs = []
  for (const v of voices) inputs.push({ id: `${v.id}-clean`, label: `${v.label}, quiet room`, voice: v, noise: null, snr: null })
  noises.forEach((n, i) => {
    const v = voices[i % voices.length]
    for (const snr of SNRS) inputs.push({ id: `${v.id}-${n.id}-${snr}db`, label: `${v.label} + ${n.label.toLowerCase()}, ${snr} dB SNR`, voice: v, noise: n, snr })
  })
  const chosen = ONLY ? inputs.filter((i) => ONLY.includes(i.id)) : inputs
  if (!chosen.length) throw new Error(`no inputs match ${ONLY}; ids: ${inputs.map((i) => i.id).join(', ')}`)

  const WORK = join(OUT, '.work')
  if (REUSE) for (const name of ['wav', 'listening-test.html', 'README.txt', 'numbers.txt']) rmSync(join(OUT, name), { recursive: true, force: true })
  else rmSync(OUT, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  // Each input plays twice: the first time warms everything up (automatic gain, leveling, the networks' state), the
  // second is what's kept. Then half a second for the chain's delays to run out.
  for (const input of chosen) {
    const T = input.voice.pcm.length
    const tail = Math.round(0.5 * RATE)
    const n = 2 * T + tail
    const speech = new Float32Array(n)
    speech.set(input.voice.pcm, 0)
    speech.set(input.voice.pcm, T)
    let x = q.mix(speech, q.pinkNoise(n, ROOM_DB, 11))
    if (input.noise) {
      const bed = kit.loopTo(input.noise.pcm, n)
      x = q.mix(x, kit.scale(bed, SPEECH_DB - input.snr - q.rmsDb(bed)))
    }
    let peak = 0
    for (const v of x) peak = Math.max(peak, Math.abs(v))
    if (peak > 0.97) throw new Error(`${input.id} would clip (peak ${peak.toFixed(2)})`)
    input.T = T
    input.wav = join(WORK, `${input.id}.wav`)
    writeFileSync(input.wav, q.wavBytes(x))
    input.played = fromInt16(toInt16(x)) // exactly what the fake mic plays
    input.clean2 = speech
  }

  // ── The browser's capture, per input and capture setting ─────────────
  log(`Capturing ${chosen.length} inputs × ${groups.length} capture settings through Chromium (real time, ${JOBS} at once)...`)
  const jobs = chosen.flatMap((input) => groups.map((group) => ({ input, group })))
  let next = 0
  const started = Date.now()
  await Promise.all(Array.from({ length: Math.min(JOBS, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      const seconds = job.input.played.length / RATE + 1.5
      const cached = join(WORK, `${job.input.id}.${groups.indexOf(job.group)}.capture`)
      let result
      try {
        if (!REUSE) throw new Error('fresh')
        const meta = JSON.parse(readFileSync(`${cached}.json`, 'utf8'))
        if (meta.key !== job.group.key || meta.length !== job.input.played.length) throw new Error('stale')
        result = { pcm: new Float32Array(file(`${cached}.f32`)), settings: meta.settings, gaps: meta.gaps }
      } catch {
        result = await capture(job.input.wav, job.group.capture, seconds)
        if (REUSE) {
          writeFileSync(`${cached}.f32`, Buffer.from(result.pcm.buffer))
          writeFileSync(`${cached}.json`, JSON.stringify({ key: job.group.key, length: job.input.played.length, settings: result.settings, gaps: result.gaps }))
        }
      }
      job.input.captures ??= {}
      job.input.captures[job.group.key] = result
      log(`  ${job.input.id}: captured (${job.group.ids.join(', ')})`)
    }
  }))
  log(`  done in ${((Date.now() - started) / 1000).toFixed(0)} s`)

  /** Where `y` lines up with the input's clean voice, judged over the second pass. */
  const align = (input, y) => kit.alignTo(input.clean2, y, input.T, 2 * input.T)
  const window = (y, at, T) => {
    const out = new Float32Array(T)
    out.set(y.subarray(Math.max(0, at), Math.max(0, Math.min(y.length, at + T))))
    return out
  }

  // SI-SDR references: each voice, clean, through each capture setting (when its clean input is in this run). The
  // browser's echo canceller and noise suppressor split the band and put it back together, which reshapes the
  // waveform in every condition alike; measured against this, SI-SDR shows what the rest of the chain does.
  const references = {}
  for (const input of chosen) {
    if (input.noise) continue
    references[input.voice.id] = {}
    for (const group of groups) {
      const c = input.captures[group.key].pcm
      const { lag } = align(input, c)
      references[input.voice.id][group.key] = window(c, lag + input.T, input.T)
    }
  }

  // ── The app's chain, Opus, the listener ───────────────────────────────
  const opus = await opusCodec()
  const report = []
  try {
    for (const input of chosen) {
      const T = input.T
      const clean = input.voice.pcm
      const phrases = input.voice.phrases
      input.clips = {}
      input.numbers = {}
      const original = input.played.subarray(T, 2 * T)
      input.clips.original = original
      input.numbers.original = kit.measureClip(clean, original, phrases)
      const captureLag = {}
      for (const group of groups) {
        const c = input.captures[group.key]
        const { lag, corr } = align(input, c.pcm)
        captureLag[group.key] = lag
        // Did the fake mic play without a gap? (The track's frames carry their times.)
        if (c.gaps) log(`  ! ${input.id}, capture ${group.ids.join('/')}: ${c.gaps} samples missing or repeated in the browser's capture`)
        if (corr < 0.2) log(`  ! ${input.id}, capture ${group.ids.join('/')}: weak alignment (${corr.toFixed(2)})`)
        c.settingsNote = `${c.settings.sampleRate} Hz, echo cancellation ${c.settings.echoCancellation}, noise suppression ${c.settings.noiseSuppression}, auto gain ${c.settings.autoGainControl}`
      }
      for (const cond of conditions) {
        const group = groups.find((g) => g.ids.includes(cond.id))
        const captured = input.captures[group.key].pcm
        const sent = await kit.micStage(captured, cond, engines)
        const { pcm: received, kbps } = await opus.roundTrip(sent, kit.KIT_OPUS)
        const heard = kit.listenerStage(received, cond)
        const { lag, corr } = align(input, heard)
        if (corr < 0.2) log(`  ! ${input.id} / ${cond.id}: weak alignment (${corr.toFixed(2)})`)
        const out = window(heard, lag + T, T)
        input.clips[cond.id] = out
        const ref = references[input.voice.id]?.[group.key]
        input.numbers[cond.id] = { ...kit.measureClip(clean, out, phrases, ref), sdrVsCapture: !!ref, latencyMs: ((lag - captureLag[group.key]) / RATE) * 1000, opusKbps: kbps }
      }
      log(`  ${input.id}: rendered`)
      report.push(input)
    }
  } finally {
    await opus.close()
  }

  // ── Numbers ────────────────────────────────────────────────────────────
  const f = (x, d = 1) => (x === undefined || x === null ? '–' : Math.abs(x) >= 99.95 ? (x > 0 ? '>99' : '<-99') : x.toFixed(d))
  const columns = [
    ['SI-SDR dB', (n) => f(n.siSdrDb)],
    ['Spectral dist. dB', (n) => f(n.spectralDistanceDb)],
    ['Voice gain dB', (n) => f(n.speechGainDb)],
    ['Dips dB', (n) => f(n.speechDipDb)],
    ['Gain motion dB/10ms', (n) => f(n.gainMotionDb, 2)],
    ['Level wander dB', (n) => f(n.levelWanderDb, 2)],
    ['Phrase starts dB', (n) => f(n.onsetDb)],
    ['Start cut ms', (n) => n.startCutMs.toFixed(0)],
    ['Word ends dB', (n) => f(n.endDb)],
    ['Pause noise dB below voice', (n) => f(n.pauseBelowVoiceDb)],
    ['Clipped', (n) => String(n.clipped)],
    ['Peak dBFS', (n) => f(n.peakDb)],
    ['Added delay ms', (n) => (n.latencyMs === undefined ? '–' : n.latencyMs.toFixed(0))],
  ]
  const names = { original: 'Original (what the mic heard)', ...Object.fromEntries(conditions.map((c) => [c.id, c.label])) }
  let text = ''
  for (const input of report) {
    text += `\n${input.label} (${input.id})\n`
    const rows = [['Condition', ...columns.map((c) => c[0])], ...Object.entries(input.numbers).map(([id, n]) => [names[id], ...columns.map((c) => c[1](n))])]
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
    for (const r of rows) text += r.map((v, i) => (i ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ') + '\n'
  }
  log(text)

  // ── Files ──────────────────────────────────────────────────────────────
  const clipIds = ['original', ...conditions.map((c) => c.id)]
  const audio = []
  const manifest = {
    created: new Date().toISOString(),
    kitId: randomBytes(6).toString('hex'),
    targetLufs: TARGET_LUFS,
    conditions: conditions.map((c) => ({ id: c.id, label: c.label })),
    inputs: report.map((input) => ({
      id: input.id,
      label: input.label,
      text: input.voice.text,
      seconds: input.T / RATE,
      clips: Object.fromEntries(clipIds.map((id) => [id, {
        gainDb: Math.max(-30, Math.min(30, TARGET_LUFS - input.numbers[id].voiceLufs)),
        numbers: input.numbers[id],
      }])),
    })),
  }
  const wavDir = join(OUT, 'wav')
  for (const input of report) {
    mkdirSync(join(wavDir, input.id), { recursive: true })
    for (const id of clipIds) {
      const pcm16 = toInt16(input.clips[id])
      writeFileSync(join(wavDir, input.id, `${input.id}__${id}.wav`), q.wavBytes(fromInt16(pcm16)))
      audio.push({ key: `${input.id}/${id}`, data: Buffer.from(encodeFlac(pcm16)).toString('base64') })
    }
  }
  const json = JSON.stringify(manifest).replaceAll('<', '\\u003c')
  const page = readFileSync(join(KIT, 'page.html'), 'utf8')
    .replace('/*KIT_MANIFEST*/null', () => json)
    .replace('<!--KIT_AUDIO-->', () => audio.map((a) => `<script type="application/octet-stream" data-clip="${a.key}">${a.data}</script>`).join('\n'))
  writeFileSync(join(OUT, 'listening-test.html'), page)
  const credits = [...voices.map((v) => `- ${v.label}: ${v.credit}`), ...noises.map((n) => `- ${n.label}: ${n.credit}`)].join('\n')
  const chain = conditions.map((c) => `- ${c.label}: browser capture with echo cancellation ${c.capture.echoCancellation ? 'on' : 'off'}, its noise suppression ${c.capture.noiseSuppression ? 'on' : 'off'}, its automatic gain ${c.capture.autoGainControl ? 'on' : 'off'}; ${c.engine === 'ai' ? `DeepFilterNet3, attenuation limit ${c.deepFilterDb === 100 ? 'none' : `${c.deepFilterDb} dB`}` : c.engine === 'rnnoise' ? 'RNNoise' : 'no noise removal of ours'}; voice gate, limiter; Opus; leveling`).join('\n')
  const readme = readFileSync(join(KIT, 'README.txt'), 'utf8')
    .replace('{{CREDITS}}', credits)
    .replace('{{CHAIN}}', chain)
    .replace('{{CREATED}}', manifest.created.slice(0, 10))
    .replace('{{INPUTS}}', report.map((i) => `- ${i.label}`).join('\n'))
  writeFileSync(join(OUT, 'README.txt'), readme.replaceAll('\n', '\r\n'))
  writeFileSync(join(OUT, 'numbers.txt'), (readFileSync(join(KIT, 'numbers-header.txt'), 'utf8') + text).replaceAll('\n', '\r\n'))
  if (!REUSE) rmSync(WORK, { recursive: true, force: true })
  log(`Kit written to ${relative(process.cwd(), OUT) || OUT}`)

  if (ZIP) {
    const entries = []
    const add = (rel) => entries.push([`iskra-listening-kit/${rel.replaceAll('\\', '/')}`, readFileSync(join(OUT, rel))])
    add('README.txt')
    add('listening-test.html')
    add('numbers.txt')
    for (const input of report) for (const id of clipIds) add(join('wav', input.id, `${input.id}__${id}.wav`))
    writeFileSync(ZIP, zip(entries))
    log(`Zipped to ${ZIP}`)
  }
} finally {
  await vite.close()
}
