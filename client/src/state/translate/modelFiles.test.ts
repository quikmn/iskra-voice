import { afterEach, describe, expect, it, vi } from 'vitest'

// A tiny model of three files, gzipped as Mozilla serves them; the model in two parts.
const made = vi.hoisted(async () => {
  const gzip = async (d: Uint8Array) => new Uint8Array(await new Response(new Blob([d.slice().buffer]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  const sha = async (d: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', d.slice().buffer))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const raw: Record<string, Uint8Array> = {
    'model.bin.gz': new Uint8Array(Array.from({ length: 5000 }, (_, i) => (i * 31) % 251)),
    'lex.bin.gz': new TextEncoder().encode('shortlist'),
    'vocab.spm.gz': new TextEncoder().encode('vocabulary'),
  }
  const partSize: Record<string, number> = { 'model.bin.gz': 100, 'lex.bin.gz': 1000, 'vocab.spm.gz': 1000 }
  const gz: Record<string, Uint8Array> = {}
  const files = []
  for (const name of Object.keys(raw)) {
    const data = gz[name] = await gzip(raw[name])
    const parts = []
    for (let o = 0; o < data.length; o += partSize[name]) {
      const slice = data.subarray(o, o + partSize[name])
      parts.push({ sha256: await sha(slice), bytes: slice.length })
    }
    files.push({ name, from: name, sha256: await sha(data), bytes: data.length, unpacked: { sha256: await sha(raw[name]), bytes: raw[name].length }, parts })
  }
  const pin = { name: 'sv-en', from: 'sv', to: 'en', dir: 'translate-sven-test', source: 'https://upstream.test', files }
  return { raw, gz, pin, partSize }
})

vi.mock('./languages', async () => {
  const { pin } = await made
  return { PINS: [pin], pinFor: (name: string) => (name === pin.name ? pin : undefined) }
})

const fake = await made

import { cachedModels, gunzip, loadModel, modelParts } from './modelFiles'

const source = { base: 'https://chat.example.org', path: '/models/translate', query: 'a=me&exp=1&sig=s' }

/** Serves the fake model's parts like an Iskra server; `tamper` changes one byte of every part. */
function serve(opts: { tamper?: boolean; status?: number } = {}) {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url)
    if (opts.status) return new Response(null, { status: opts.status })
    const match = /\/translate-sven-test\/(.+)\.part(\d+)\.bin\?/.exec(url)
    if (!match) return new Response(null, { status: 404 })
    const [, name, i] = match
    const size = fake.partSize[name]
    const part = fake.gz[name].slice(Number(i) * size, (Number(i) + 1) * size)
    if (opts.tamper) part[0] ^= 1
    return new Response(part)
  })
  return urls
}

afterEach(() => vi.unstubAllGlobals())

describe('translation model files', () => {
  it('asks the server for each part with the member’s link', () => {
    const parts = modelParts(fake.pin, fake.pin.files[0], source)
    expect(parts.length).toBe(Math.ceil(fake.gz['model.bin.gz'].length / 100))
    expect(parts[1].url).toBe('https://chat.example.org/models/translate/translate-sven-test/model.bin.gz.part1.bin?a=me&exp=1&sig=s')
  })

  it('checks every part, unpacks and checks again', async () => {
    const urls = serve()
    let bytes = 0
    const files = await loadModel('sv-en', source, (n) => (bytes += n))
    expect(files.model).toEqual(fake.raw['model.bin.gz'])
    expect(new TextDecoder().decode(files.lex)).toBe('shortlist')
    expect(new TextDecoder().decode(files.vocab)).toBe('vocabulary')
    expect(bytes).toBe(fake.pin.files.reduce((n, f) => n + f.bytes, 0))
    expect(urls.every((u) => u.startsWith('https://chat.example.org/models/translate/translate-sven-test/'))).toBe(true)
  })

  it('refuses a part that isn’t the pinned one', async () => {
    serve({ tamper: true })
    await expect(loadModel('sv-en', source, () => undefined)).rejects.toMatchObject({ kind: 'corrupt' })
  })

  it('says “not offered” when the server answers 404, or there is no server and it isn’t here', async () => {
    serve({ status: 404 })
    await expect(loadModel('sv-en', source, () => undefined)).rejects.toMatchObject({ kind: 'notOffered' })
    serve({ status: 500 })
    await expect(loadModel('sv-en', null, () => undefined)).rejects.toMatchObject({ kind: 'notOffered' })
    await expect(loadModel('xx-en', source, () => undefined)).rejects.toMatchObject({ kind: 'notOffered' })
  })

  it('keeps nothing where there is no storage (and says so)', async () => {
    expect(await cachedModels(['sv-en'])).toEqual([])
  })

  it('unpacks gzip with the platform’s stream', async () => {
    const data = new TextEncoder().encode('hej '.repeat(100))
    expect(await gunzip(fake.gz['vocab.spm.gz'])).toEqual(fake.raw['vocab.spm.gz'])
    await expect(gunzip(data)).rejects.toThrow()
  })
})
