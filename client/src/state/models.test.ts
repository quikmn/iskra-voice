import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from './captions/model.json'
import { captionParts, captionsOffered, loadCaptionModel, ModelError, sha256Hex } from './models'

describe('where the captions model comes from', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("asks the call's own server, without making it fetch anything", async () => {
    const answers: Record<string, number> = { 'https://on.test': 200, 'https://off.test': 404, 'https://broken.test': 502 }
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD')
      expect(url).toContain(`/models/${manifest.dir}/vocab.json.part0.bin`)
      return new Response(null, { status: answers[new URL(url).origin] })
    })
    vi.stubGlobal('fetch', fetch)
    expect(await captionsOffered('https://on.test')).toBe('yes')
    expect(await captionsOffered('https://off.test')).toBe('no')
    expect(await captionsOffered('https://broken.test')).toBe('unreachable')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    expect(await captionsOffered('https://on.test')).toBe('unreachable')
  })

  it('asks for every part of the pinned version, each with its own hash, under 20 MiB', () => {
    const parts = captionParts('https://x.test')
    expect(parts.encoder.map((p) => p.url)).toEqual([
      `https://x.test/models/${manifest.dir}/encoder.q8.onnx.part0.bin`,
      `https://x.test/models/${manifest.dir}/encoder.q8.onnx.part1.bin`,
    ])
    expect(parts.decoder).toHaveLength(3)
    expect(parts.vocab).toHaveLength(1)
    for (const p of Object.values(parts).flat()) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(p.bytes).toBeLessThanOrEqual(20 * 1024 * 1024)
    }
    for (const f of manifest.files) expect(f.parts.reduce((n, p) => n + p.bytes, 0)).toBe(f.bytes)
  })
})

describe('downloading it', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A host that serves `body` for every model part (and something for the runtime). */
  const serve = (body: (url: string) => Uint8Array | null) => {
    vi.stubGlobal('location', { protocol: 'https:', origin: 'https://app.test', href: 'https://app.test/' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!url.includes('/models/')) return new Response(new Uint8Array(4))
      const data = body(url)
      return data ? new Response(data.slice()) : new Response('gone', { status: 503 })
    }))
  }

  it('refuses a part whose SHA-256 is not the one compiled into the app', async () => {
    serve(() => new Uint8Array(10))
    const error = await loadCaptionModel('https://srv.test').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).kind).toBe('corrupt')
  })

  it('says the download failed when the server is down, and not offered when it says 404', async () => {
    serve(() => null)
    const error = await loadCaptionModel('https://srv.test').catch((e: unknown) => e)
    expect((error as ModelError).kind).toBe('download')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('', { status: url.includes('/models/') ? 404 : 200 })))
    expect(((await loadCaptionModel('https://srv.test').catch((e: unknown) => e)) as ModelError).kind).toBe('notOffered')
  })

  it('can be cancelled', async () => {
    vi.stubGlobal('location', { protocol: 'https:', origin: 'https://app.test', href: 'https://app.test/' })
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'))
      if (init?.signal?.aborted) abort()
      init?.signal?.addEventListener('abort', abort)
    })))
    const controller = new AbortController()
    const loading = loadCaptionModel('https://srv.test', undefined, controller.signal).catch((e: unknown) => e)
    controller.abort()
    expect(((await loading) as ModelError).kind).toBe('cancelled')
  })

  it('hashes like everyone else', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
