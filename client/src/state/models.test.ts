import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from './captions/model.json'
import { captionParts, captionSource, loadCaptionModel, ModelError, sha256Hex } from './models'

describe('where the captions model comes from', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("asks the call's own server for a members-only link, without anything being downloaded", async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const link = { offered: true as const, path: `/models/${manifest.dir}`, query: 'a=k&exp=1&sig=s', expires: 1 }
    expect(await captionSource('https://on.test', async () => link)).toEqual({ base: 'https://on.test', query: 'a=k&exp=1&sig=s' })
    expect(await captionSource('https://off.test', async () => ({ offered: false }))).toBe('no')
    expect(await captionSource('https://down.test', async () => { throw new Error('not connected') })).toBe('unreachable')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks for every part of the pinned version with the link, each with its own hash, under 20 MiB', () => {
    const parts = captionParts({ base: 'https://x.test', query: 'a=k&exp=1&sig=s' })
    expect(parts.encoder.map((p) => p.url)).toEqual([
      `https://x.test/models/${manifest.dir}/encoder.q8.onnx.part0.bin?a=k&exp=1&sig=s`,
      `https://x.test/models/${manifest.dir}/encoder.q8.onnx.part1.bin?a=k&exp=1&sig=s`,
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

const SRV = { base: 'https://srv.test', query: 'a=k&exp=1&sig=s' }

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
    const error = await loadCaptionModel(SRV).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).kind).toBe('corrupt')
  })

  it('says the download failed when the server is down, and not offered when it says 404', async () => {
    serve(() => null)
    const error = await loadCaptionModel(SRV).catch((e: unknown) => e)
    expect((error as ModelError).kind).toBe('download')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('', { status: url.includes('/models/') ? 404 : 200 })))
    expect(((await loadCaptionModel(SRV).catch((e: unknown) => e)) as ModelError).kind).toBe('notOffered')
  })

  it('can be cancelled', async () => {
    vi.stubGlobal('location', { protocol: 'https:', origin: 'https://app.test', href: 'https://app.test/' })
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'))
      if (init?.signal?.aborted) abort()
      init?.signal?.addEventListener('abort', abort)
    })))
    const controller = new AbortController()
    const loading = loadCaptionModel(SRV, undefined, controller.signal).catch((e: unknown) => e)
    controller.abort()
    expect(((await loading) as ModelError).kind).toBe('cancelled')
  })

  it('hashes like everyone else', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
