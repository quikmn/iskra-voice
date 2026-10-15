// Writes client/src/state/translate/models.json: the message-translation models (Mozilla's Firefox Translations
// models, run by Bergamot) that Iskra servers may fetch and serve to their members, pinned by path and SHA-256.
// Only for changing the pins (new languages, newer models); the pins are then reviewed and committed like code.
// Servers and apps never read Mozilla's registry: they only use the pinned paths and hashes.
//   node scripts/translate-pins.mjs                → the default languages
//   node scripts/translate-pins.mjs sv de fr       → only these (to and from English)
// Each file is downloaded once to hash it (gzip as served, plus its unpacked size and hash, which the app checks too).
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json'
const PART = 20 * 1024 * 1024
const DEFAULT = ['sv', 'de', 'fr', 'es', 'pl', 'it', 'nl', 'pt', 'da', 'nb', 'fi', 'uk']
const languages = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT
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

const registry = await (await fetch(REGISTRY)).json()
const base = registry.baseUrl
if (!base.startsWith('https://')) throw new Error(`unexpected registry base ${base}`)

/** Released models only (Firefox ships them); a desktop build when there are two. */
function pick(from, to) {
  const all = (registry.models[`${from}-${to}`] ?? []).filter((m) => m.releaseStatus?.startsWith('Release'))
  const chosen = all.find((m) => m.releaseStatus === 'Release Desktop') ?? all.find((m) => m.releaseStatus === 'Release')
  if (!chosen) throw new Error(`no released ${from}-${to} model`)
  if (!chosen.files.vocab || chosen.files.srcVocab) throw new Error(`${from}-${to}: separate vocabularies aren't supported`)
  return chosen
}

const models = []
for (const language of languages) {
  for (const [from, to] of [['en', language], [language, 'en']]) {
    const entry = pick(from, to)
    const files = []
    for (const [kind, name] of [['model', 'model.bin.gz'], ['lexicalShortlist', 'lex.bin.gz'], ['vocab', 'vocab.spm.gz']]) {
      const path = entry.files[kind].path
      const data = await download(`${base}/${path}`)
      const unpacked = gunzipSync(data)
      const expected = entry.files[kind].uncompressedHash
      if (expected && sha256(unpacked) !== expected) throw new Error(`${from}-${to} ${kind}: not the registry's file`)
      const parts = []
      for (let o = 0; o < data.length; o += PART) {
        const slice = data.subarray(o, o + PART)
        parts.push({ sha256: sha256(slice), bytes: slice.length })
      }
      files.push({ name, from: path, sha256: sha256(data), bytes: data.length, unpacked: { sha256: sha256(unpacked), bytes: unpacked.length }, parts })
    }
    const run = entry.files.model.path.split('/')[2]
    const id = sha256(Buffer.from(files.map((f) => f.sha256).join(''))).slice(0, 8)
    models.push({ name: `${from}-${to}`, from, to, architecture: entry.architecture, run, dir: `translate-${from}${to}-${id}`, source: base, files })
    console.log(`${from}-${to}: ${entry.architecture}, ${files.reduce((n, f) => n + f.bytes, 0)} bytes`)
  }
}

const out = join(ROOT, 'client/src/state/translate/models.json')
writeFileSync(out, `${JSON.stringify({ engine: 'bergamot', pivot: 'en', registry: REGISTRY, models }, null, 2)}\n`)
console.log(`wrote ${out}`)
