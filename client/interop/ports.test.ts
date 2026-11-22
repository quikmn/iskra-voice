// The port helper itself: every port it hands out is one the tests can reach, inside this worker's own range.
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

/** Every port a helper gives until its range is used up (a fresh copy of the module, so nothing is handed out yet). */
async function drain(which: 'freePort' | 'freeUdpPort') {
  vi.resetModules()
  const ports = await import('./ports')
  const got: number[] = []
  for (;;) {
    try {
      got.push(await ports[which]())
    } catch {
      return { got, ...ports }
    }
  }
}

describe('interop ports', () => {
  it('fetch refuses a blocked port even when a server listens there, and the helper knows the same list', async () => {
    const { fetchable, FETCH_BLOCKED } = await import('./ports')
    const reason = (port: number) => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })
      .then(() => 'answered', (e: { cause?: { message?: string } }) => e.cause?.message ?? 'failed')
    // What happened on CI: the server was up on 10080 and no fetch ever reached it.
    const server = createServer((_, res) => res.end('ok'))
    const listening = await new Promise<boolean>((done) => {
      server.once('error', () => done(false))
      server.listen(10080, '127.0.0.1', () => done(true))
    })
    try {
      if (listening) expect(await reason(10080)).toBe('bad port')
    } finally {
      await new Promise((done) => server.close(done))
    }
    // Refused before any connection, so this is quick: the list here is the one fetch uses.
    for (const port of FETCH_BLOCKED) {
      expect(await reason(port), `port ${port}`).toBe('bad port')
      expect(fetchable(port)).toBe(false)
    }
    expect(fetchable(10081)).toBe(true)
    expect([...FETCH_BLOCKED].some((port) => port >= 10000 && port < 10600)).toBe(true) // why this matters here
  })

  it('hands out only reachable ports of its own range, each once', async () => {
    const { got, rangeStart, RANGE, fetchable } = await drain('freePort')
    expect(got.length).toBeGreaterThan(RANGE / 2) // most of the range is free on any machine
    expect(new Set(got).size).toBe(got.length)
    for (const port of got) {
      expect(port).toBeGreaterThanOrEqual(rangeStart)
      expect(port).toBeLessThan(rangeStart + RANGE)
      expect(fetchable(port), `port ${port}`).toBe(true)
    }
  })

  it('a UDP port and the one after it both stay inside the range', async () => {
    const { got, rangeStart, RANGE } = await drain('freeUdpPort')
    expect(got.length).toBeGreaterThan(RANGE / 4)
    for (const port of got) {
      expect(port).toBeGreaterThanOrEqual(rangeStart)
      expect(port + 1).toBeLessThan(rangeStart + RANGE)
      expect(got).not.toContain(port + 1)
    }
  })
})
