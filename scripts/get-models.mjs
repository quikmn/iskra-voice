// Fetches the live-captions model (Whisper base, pinned by commit and SHA-256 in client/src/state/captions/model.json)
// and writes it as parts of at most 20 MiB, exactly as Iskra servers serve it: <out>/models/<dir>/<file>.part<n>.bin.
// For development and tests only: real servers fetch the model themselves (server/src/Iskra.Server/Captions/), and
// it's never committed to git.
//   node scripts/get-models.mjs          → client/.models (ignored; test servers use it via Captions.ModelSource, and
//                                          the Whisper unit test and scripts/bench-captions.mjs read it)
//   node scripts/get-models.mjs --out X  → somewhere else
//   node scripts/get-models.mjs --blur   → also re-fetch the vendored Selfie Segmenter to check it
//   node scripts/get-models.mjs --translate [sv|de,fr|all] → also message-translation models (models/translate/<dir>/)
// Parts already there with the right hash are kept, so it's cheap to run again.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'client/src/state/captions/model.json'), 'utf8'))
const PART = 20 * 1024 * 1024
const args = process.argv.slice(2)
const outArg = args.indexOf('--out')
const out = resolve(outArg >= 0 ? args[outArg + 1] : join(ROOT, 'client/.models'))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${url}: ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    } catch (e) {
      if (attempt === 3) throw e
      console.warn(`retrying ${url}: ${e.message}`)
    }
  }
}

const dir = join(out, 'models', MANIFEST.dir)
mkdirSync(dir, { recursive: true })
for (const f of MANIFEST.files) {
  const paths = f.parts.map((_, i) => join(dir, `${f.name}.part${i}.bin`))
  if (paths.every((p, i) => existsSync(p) && sha256(readFileSync(p)) === f.parts[i].sha256)) {
    console.log(`${f.name}: already there`)
    continue
  }
  const data = await download(`${MANIFEST.source}/${f.from}`)
  if (sha256(data) !== f.sha256) throw new Error(`${f.name}: sha256 ${sha256(data)}, expected ${f.sha256}`)
  f.parts.forEach((part, i) => {
    const slice = data.subarray(i * PART, (i + 1) * PART)
    if (sha256(slice) !== part.sha256 || slice.length !== part.bytes) throw new Error(`${f.name} part ${i}: doesn't match model.json`)
    writeFileSync(paths[i], slice)
  })
  console.log(`${f.name}: ${data.length} bytes in ${f.parts.length} part(s)`)
}
console.log(`Whisper base is in ${dir}`)

// Message translation (client/src/state/translate/models.json): Swedish to and from English by default,
// `--translate de,fr` for those languages, `--translate all` for every pinned pair.
const translateArg = args.indexOf('--translate')
if (translateArg >= 0) {
  const pins = JSON.parse(readFileSync(join(ROOT, 'client/src/state/translate/models.json'), 'utf8'))
  const wanted = args[translateArg + 1] && !args[translateArg + 1].startsWith('--') ? args[translateArg + 1] : 'sv'
  const langs = wanted === 'all' ? null : new Set(wanted.split(','))
  for (const model of pins.models) {
    if (langs && !langs.has(model.from) && !langs.has(model.to)) continue
    const target = join(out, 'models', 'translate', model.dir)
    mkdirSync(target, { recursive: true })
    for (const f of model.files) {
      const paths = f.parts.map((_, i) => join(target, `${f.name}.part${i}.bin`))
      if (paths.every((p, i) => existsSync(p) && sha256(readFileSync(p)) === f.parts[i].sha256)) continue
      const data = await download(`${model.source}/${f.from}`)
      if (sha256(data) !== f.sha256) throw new Error(`${model.name} ${f.name}: sha256 ${sha256(data)}, expected ${f.sha256}`)
      f.parts.forEach((part, i) => writeFileSync(paths[i], data.subarray(i * PART, i * PART + part.bytes)))
    }
    console.log(`${model.name}: in ${target}`)
  }
}

if (args.includes('--blur')) {
  // MediaPipe Selfie Segmenter, general model (Google, Apache-2.0), version 1: committed in client/vendor/mediapipe.
  const url = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite'
  const expected = '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b'
  const data = await download(url)
  if (sha256(data) !== expected) throw new Error(`selfie_segmenter.tflite: sha256 ${sha256(data)}, expected ${expected}`)
  const target = join(ROOT, 'client/vendor/mediapipe/selfie_segmenter.tflite')
  if (!existsSync(target) || sha256(readFileSync(target)) !== expected) writeFileSync(target, data)
  console.log('selfie_segmenter.tflite: matches')
}
