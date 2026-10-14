import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Connection, RESTART_WINDOW_MS, restartHint, type ConnectionStatus } from './connection'
import type { Identity } from './identity'

/** A socket the test drives: it never connects by itself. */
class FakeSocket {
  static all: FakeSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  sent: string[] = []
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
  /** The server let us in (the handshake itself is tested against the real server). */
  welcome() {
    this.onmessage?.({ data: JSON.stringify({ type: 'welcome', body: { you: {}, channels: [], members: [] } }) })
  }
  drop(code: number, reason = '') {
    this.onclose?.({ code, reason })
  }
}

const RESTART = JSON.stringify({ v: 1, reason: 'restart' })

function connect() {
  const statuses: ConnectionStatus[] = []
  const connection = new Connection({
    serverUrl: 'http://localhost:47070',
    identity: {} as Identity,
    name: () => 'Ann',
    onStatus: (s) => statuses.push(s),
    onWelcome: () => undefined,
    onEvent: () => undefined,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  })
  connection.start()
  return { connection, statuses, last: () => statuses.at(-1)!, socket: () => FakeSocket.all.at(-1)! }
}

/** How many sockets get opened in `ms`, each attempt failing straight away (the server is still down). */
async function attemptsWithin(ms: number, failWith = 1006): Promise<number> {
  const before = FakeSocket.all.length
  let seen = before
  const end = Date.now() + ms
  while (Date.now() < end) {
    await vi.advanceTimersByTimeAsync(50)
    while (seen < FakeSocket.all.length) FakeSocket.all[seen++].drop(failWith)
  }
  return FakeSocket.all.length - before
}

/** Waits for the next attempt, however the jitter fell: at most the longest backoff (30 s + 30%). */
async function nextAttempt(): Promise<FakeSocket> {
  const count = FakeSocket.all.length
  const end = Date.now() + 39_000
  while (FakeSocket.all.length === count && Date.now() <= end) await vi.advanceTimersByTimeAsync(100)
  expect(FakeSocket.all.length).toBe(count + 1)
  return FakeSocket.all.at(-1)!
}

describe('connection: reconnecting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.all = []
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('backs off on an ordinary drop', async () => {
    const { last, socket } = connect()
    socket().welcome()
    socket().drop(1006)
    expect(last().state).toBe('offline')
    // 0.5, 1, 2, 4, 8 s (±30%): a handful of attempts in 30 s, not dozens.
    const tries = await attemptsWithin(30_000)
    expect(tries).toBeGreaterThanOrEqual(4)
    expect(tries).toBeLessThanOrEqual(7)
    expect(last()).toMatchObject({ state: 'offline' })
    if (last().state === 'offline') expect((last() as { retryInMs: number }).retryInMs).toBeGreaterThan(5_000)
  })

  it('retries about every second while the server restarts, and says so', async () => {
    const { statuses, last, socket } = connect()
    socket().welcome()
    socket().drop(1012, RESTART)
    expect(last()).toMatchObject({ state: 'restarting' })
    expect(last()).not.toHaveProperty('update') // a plain restart, not an update

    const tries = await attemptsWithin(30_000)
    expect(tries).toBeGreaterThanOrEqual(24) // 0.75–1.25 s apart
    expect(tries).toBeLessThanOrEqual(41)
    // Never "offline" or "connecting" while it restarts: the banner stays calm and steady.
    const during = statuses.slice(statuses.findIndex((s) => s.state === 'restarting'))
    expect(during.every((s) => s.state === 'restarting')).toBe(true)
    const since = (during[0] as { since: number }).since
    expect(during.every((s) => (s as { since: number }).since === since)).toBe(true)
  })

  it('jitters the quick retries', async () => {
    const delays = new Set<number>()
    const { socket } = connect()
    socket().welcome()
    socket().drop(1012, RESTART)
    let at = Date.now()
    for (let i = 0; i < 10; i++) {
      const count = FakeSocket.all.length
      while (FakeSocket.all.length === count) await vi.advanceTimersByTimeAsync(10)
      delays.add(Math.round((Date.now() - at) / 10))
      at = Date.now()
      socket().drop(1006)
    }
    expect(delays.size).toBeGreaterThan(1)
    for (const d of delays) expect(d * 10).toBeGreaterThanOrEqual(740)
    for (const d of delays) expect(d * 10).toBeLessThanOrEqual(1260)
  })

  it('falls back to the usual backoff after about two minutes', async () => {
    const { last, socket } = connect()
    socket().welcome()
    socket().drop(1012, RESTART)
    await attemptsWithin(RESTART_WINDOW_MS + 2_000)
    expect(last().state).toBe('offline')
    expect(await attemptsWithin(30_000)).toBeLessThanOrEqual(7)
  })

  it('waits longer when the server says the restart takes longer', async () => {
    const { last, socket } = connect()
    socket().welcome()
    socket().drop(1012, JSON.stringify({ v: 1, reason: 'update', etaMs: 120_000 }))
    expect(last()).toMatchObject({ state: 'restarting', etaMs: 120_000, update: true })
    await attemptsWithin(RESTART_WINDOW_MS + 30_000)
    expect(last().state).toBe('restarting') // eta + a minute = 3 minutes
  })

  it('goes back online when the server is back, and a later drop backs off again', async () => {
    const { last, socket } = connect()
    socket().welcome()
    socket().drop(1012, RESTART)
    await attemptsWithin(5_000)
    await vi.advanceTimersByTimeAsync(1_300)
    socket().welcome()
    expect(last().state).toBe('online')

    socket().drop(1006)
    expect(last().state).toBe('offline')
  })

  // Whatever the jitter draws. CI once drew short delays and then a long one (the 7th attempt, 39 s away at
  // 22 s), and a fixed 31 s wait fell short.
  it.each([
    ['short', () => 0],
    ['long', () => 0.999],
    ['short, then long', (n: number) => (n < 6 ? 0 : 0.999)],
  ])('backs off as usual when the server stopped for good, and says so until it is back (jitter: %s)', async (_, jitter) => {
    let n = 0
    vi.spyOn(Math, 'random').mockImplementation(() => jitter(n++))
    const { last, socket } = connect()
    socket().welcome()
    socket().drop(1001, JSON.stringify({ v: 1, reason: 'stop' }))
    expect(last()).toMatchObject({ state: 'offline', stopped: true })
    const tries = await attemptsWithin(30_000)
    expect(tries).toBeLessThanOrEqual(7) // not the quick restart pace
    expect(last()).toMatchObject({ state: 'offline', stopped: true }) // later failures don't forget why
    // The next attempt can be up to 39 s away (30 s cap, +30% jitter); a fixed 31 s wait sometimes fell short.
    const back = await nextAttempt()
    back.welcome()
    expect(last().state).toBe('online')
    back.drop(1006)
    expect(last()).not.toHaveProperty('stopped')
  })

  it("treats an old server's plain 1001 as an ordinary drop", () => {
    const { last, socket } = connect()
    socket().welcome()
    socket().drop(1001, 'Server is restarting')
    expect(last()).toMatchObject({ state: 'offline' })
    expect(last()).not.toHaveProperty('stopped')
  })

  it('asks where to connect before every attempt, and drops an answer for an attempt that was stopped', async () => {
    const statuses: ConnectionStatus[] = []
    let answer: () => Promise<string | null> = async () => 'http://127.0.0.1:51234'
    const connection = new Connection({
      serverUrl: 'http://192.168.1.20:47070',
      identity: {} as Identity,
      name: () => 'Ann',
      resolveUrl: () => answer(),
      onStatus: (s) => statuses.push(s),
      onWelcome: () => undefined,
      onEvent: () => undefined,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    connection.start()
    expect(statuses.at(-1)?.state).toBe('connecting')
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeSocket.all.at(-1)!.url).toBe('ws://127.0.0.1:51234/ws') // the tunnel, not the saved address
    FakeSocket.all.at(-1)!.welcome()
    expect(statuses.at(-1)?.state).toBe('online')

    // Null (or a failure) means the saved address.
    answer = async () => null
    FakeSocket.all.at(-1)!.drop(1006)
    await nextAttempt()
    expect(FakeSocket.all.at(-1)!.url).toBe('ws://192.168.1.20:47070/ws')
    answer = () => Promise.reject(new Error('no tunnel'))
    FakeSocket.all.at(-1)!.drop(1006)
    await nextAttempt()
    expect(FakeSocket.all.at(-1)!.url).toBe('ws://192.168.1.20:47070/ws')

    // Stopped while the address was still being worked out: no socket is opened afterwards.
    let release: (url: string) => void = () => undefined
    answer = () => new Promise((r) => (release = r))
    FakeSocket.all.at(-1)!.drop(1006)
    const count = FakeSocket.all.length
    await vi.advanceTimersByTimeAsync(40_000)
    connection.stop()
    release('http://127.0.0.1:51234')
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeSocket.all.length).toBe(count)
  })

  it('reads the restart reason defensively', () => {
    expect(restartHint('{"v":1,"reason":"update","etaMs":20000}')).toEqual({ reason: 'update', etaMs: 20000 })
    expect(restartHint('{"v":2,"reason":"restart","extra":true}')).toEqual({ reason: 'restart' })
    expect(restartHint('{"v":1,"etaMs":-5}')).toEqual({ reason: 'restart' })
    expect(restartHint('{"v":1,"etaMs":99999999}')).toEqual({ reason: 'restart' })
    expect(restartHint('Server is restarting')).toEqual({ reason: 'restart' })
    expect(restartHint('')).toEqual({ reason: 'restart' })
  })
})
