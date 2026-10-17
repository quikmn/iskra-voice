import { describe, expect, it, vi } from 'vitest'
import sdkSource from '../../../protocol/activity-sdk.js?raw'
import {
  asJson, frameTheme, initMessage, MAX_DATA_BYTES, MAX_STATE_BYTES, nextMessages, parseFrameRequest, parseWallLine, TokenBucket, WALL_LINE, wallScript,
} from './activityHost'
import { mayEnd, startRefusal } from './activities'
import type { ActivityCatalog, ActivitySession, Channel, Member } from '../core/protocol'
import type { ServerState } from './store'

describe('what a frame may ask', () => {
  it('takes only known, versioned requests with JSON payloads', () => {
    expect(parseFrameRequest({ iskra: 1, type: 'ready' })).toEqual({ type: 'ready' })
    expect(parseFrameRequest({ iskra: 1, type: 'end', extra: 1 })).toEqual({ type: 'end' })
    expect(parseFrameRequest({ iskra: 1, type: 'send', data: { t: 'drop', col: 3 } })).toEqual({ type: 'send', data: { t: 'drop', col: 3 } })
    expect(parseFrameRequest({ iskra: 1, type: 'state', seq: 4, state: [1, 2] })).toEqual({ type: 'state', seq: 4, state: [1, 2] })
    for (const bad of [
      null, 'ready', [], { type: 'ready' }, { iskra: 2, type: 'ready' }, { iskra: 1, type: 'fetch', url: 'https://x' },
      { iskra: 1, type: 'send' }, { iskra: 1, type: 'send', data: () => 1 }, { iskra: 1, type: 'state', state: {} },
      { iskra: 1, type: 'state', seq: -1, state: {} }, { iskra: 1, type: 'state', seq: 1.5, state: {} }, { iskra: 1, type: 'state', seq: 1 },
    ]) expect(parseFrameRequest(bad)).toBeNull()
  })

  it('refuses payloads over the limits, measured as UTF-8 JSON', () => {
    expect(parseFrameRequest({ iskra: 1, type: 'send', data: 'x'.repeat(MAX_DATA_BYTES - 2) })).not.toBeNull()
    expect(parseFrameRequest({ iskra: 1, type: 'send', data: 'x'.repeat(MAX_DATA_BYTES) })).toBeNull()
    expect(parseFrameRequest({ iskra: 1, type: 'send', data: 'å'.repeat(MAX_DATA_BYTES / 2) })).toBeNull() // two bytes each
    expect(parseFrameRequest({ iskra: 1, type: 'state', seq: 0, state: 'x'.repeat(MAX_STATE_BYTES) })).toBeNull()
  })

  it('turns values into plain JSON (what the server relays)', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(asJson(cyclic)).toBeNull()
    expect(asJson(1n)).toBeNull()
    expect(asJson(undefined)).toBeNull()
    expect(asJson({ a: undefined, b: new Date(0) })).toEqual({ value: { b: '1970-01-01T00:00:00.000Z' }, bytes: 32 })
  })

  it("reads the walled view's console lines, nothing else", () => {
    expect(parseWallLine(`${WALL_LINE}{"iskra":1,"type":"ready"}`)).toEqual({ type: 'ready' })
    expect(parseWallLine('{"iskra":1,"type":"ready"}')).toBeNull()
    expect(parseWallLine(`${WALL_LINE}{not json`)).toBeNull()
    expect(parseWallLine(42)).toBeNull()
    expect(parseWallLine(WALL_LINE + 'x'.repeat(MAX_STATE_BYTES * 3))).toBeNull()
  })

  it('writes messages into the walled view as a safe literal', () => {
    const script = wallScript({ text: 'a b"); alert(1); ("' })
    expect(script).not.toContain(' ')
    let got: unknown
    new Function('window', script)({ postMessage: (m: unknown) => (got = m) })
    expect(got).toEqual({ text: 'a b"); alert(1); ("' })
  })
})

describe('the bridge', () => {
  it('hands over each message once, in order, from the join answer and live ones', () => {
    const m = (seq: number) => ({ seq, from: 'p', data: seq })
    expect(nextMessages(2, [m(1), m(2), m(3), m(4)], [m(5), m(3)]).map((x) => x.seq)).toEqual([3, 4, 5])
    expect(nextMessages(0, [], [m(2), m(1)]).map((x) => x.seq)).toEqual([1, 2])
  })

  it('limits sends like the server does', () => {
    let now = 0
    const bucket = new TokenBucket(3, 1, () => now)
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false])
    now = 1000
    expect([bucket.take(), bucket.take()]).toEqual([true, false])
  })

  it('passes on only plain colours', () => {
    const vars: Record<string, string> = { '--stage': '#07070d', '--accent': ' rgba(1, 2, 3, 0.5)', '--text': 'url(https://x/)', '--red': 'expression(1)' }
    const theme = frameTheme((v) => vars[v] ?? '', 'dark')
    expect(theme).toEqual({ scheme: 'dark', colors: { bg: '#07070d', accent: 'rgba(1, 2, 3, 0.5)' } })
    expect(initMessage({ me: { id: 'a', name: 'A' }, players: [], state: null, stateSeq: 0, locale: 'en', theme, activity: { id: 'four', name: 'x' } }).iskra).toBe(1)
  })
})

/** Runs the SDK (protocol/activity-sdk.js) against a fake window with a parent frame. */
function loadSdk(walled = false) {
  const listeners: ((e: { source: unknown; data: unknown }) => void)[] = []
  const posted: unknown[] = []
  const logged: string[] = []
  const timers: (() => void)[] = []
  const parent = { postMessage: (m: unknown) => posted.push(m) }
  const win: Record<string, unknown> = {
    addEventListener: (_: string, fn: (e: { source: unknown; data: unknown }) => void) => listeners.push(fn),
    console: { debug: (line: string) => logged.push(line), error: () => undefined },
    setTimeout: (fn: () => void) => timers.push(fn),
  }
  win.parent = walled ? win : parent
  new Function('window', sdkSource)(win)
  const from = (source: unknown, data: unknown) => listeners.forEach((fn) => fn({ source, data }))
  const tick = () => timers.splice(0).forEach((fn) => fn())
  return { iskra: win.iskra as Record<string, (...a: never[]) => unknown> & { me: unknown; players: unknown; host: unknown }, posted, logged, from, parent, win, tick }
}

describe('the activity SDK', () => {
  it('says ready, then gets who it is and the snapshot', async () => {
    const { iskra, posted, from, parent } = loadSdk()
    const ready = (iskra.ready as () => Promise<{ me: unknown; state: unknown }>)()
    expect(posted).toEqual([{ type: 'ready', iskra: 1 }])
    from({}, { iskra: 1, type: 'init', me: { id: 'x' }, players: [] }) // not from the parent: ignored
    from(parent, { iskra: 1, type: 'init', me: { id: 'me1', name: 'Me' }, players: [{ id: 'me1', name: 'Me' }], state: { n: 1 }, stateSeq: 7, locale: 'sv' })
    const init = await ready
    expect(init.state).toEqual({ n: 1 })
    expect(iskra.me).toEqual({ id: 'me1', name: 'Me' })
    expect(iskra.host).toBe('me1')

    // setState names the last message it has seen (the snapshot's, until a message arrives).
    ;(iskra.setState as (s: unknown) => void)({ n: 2 })
    expect(posted.at(-1)).toEqual({ type: 'state', seq: 7, state: { n: 2 }, iskra: 1 })
  })

  it('holds messages until someone listens, then delivers them in order', () => {
    const { iskra, posted, from, parent, tick } = loadSdk()
    void (iskra.ready as () => Promise<unknown>)()
    from(parent, { iskra: 1, type: 'init', me: { id: 'a' }, players: [] })
    from(parent, { iskra: 1, type: 'message', seq: 1, from: 'a', data: 'one' })
    from(parent, { iskra: 1, type: 'message', seq: 2, from: 'b', data: 'two' })
    const got: unknown[] = []
    ;(iskra.on as (e: string, fn: (...a: unknown[]) => void) => void)('message', (data, who, seq) => got.push([data, who, seq]))
    from(parent, { iskra: 1, type: 'message', seq: 3, from: 'a', data: 'three' }) // waits behind the held ones
    expect(got).toEqual([])
    tick()
    expect(got).toEqual([['one', 'a', 1], ['two', 'b', 2], ['three', 'a', 3]])
    from(parent, { iskra: 1, type: 'message', seq: 4, from: 'a', data: 'four' })
    expect(got).toHaveLength(4)
    ;(iskra.send as (d: unknown) => void)({ t: 'x' })
    ;(iskra.setState as (s: unknown) => void)({})
    expect(posted.slice(-2)).toEqual([{ type: 'send', data: { t: 'x' }, iskra: 1 }, { type: 'state', seq: 4, state: {}, iskra: 1 }])
  })

  it('ignores everything before init, and unknown events', () => {
    const { iskra, from, parent } = loadSdk()
    const players = vi.fn()
    ;(iskra.on as (e: string, fn: () => void) => void)('players', players)
    from(parent, { iskra: 1, type: 'players', players: [] })
    expect(players).not.toHaveBeenCalled()
    expect(() => (iskra.on as (e: string, fn: () => void) => void)('fetch', () => undefined)).toThrow()
  })

  it('talks over console lines in the walled view (no parent frame)', () => {
    const { iskra, logged, from, win } = loadSdk(true)
    void (iskra.ready as () => Promise<unknown>)()
    expect(logged).toEqual([`${WALL_LINE}{"type":"ready","iskra":1}`])
    expect(parseWallLine(logged[0])).toEqual({ type: 'ready' })
    from(win, { iskra: 1, type: 'init', me: { id: 'w' }, players: [] }) // the app posts into the view itself
    expect(iskra.me).toEqual({ id: 'w' })
  })
})

describe('who may start and end', () => {
  const me: Member = { accountKey: 'me', name: 'Me', role: 'member', online: true, bot: false } as Member
  const server = { me, voice: {} } as unknown as ServerState
  const channel = { id: 5, kind: 'voice', writeRole: 'member', readRole: 'member' } as Channel
  const catalog: ActivityCatalog = { activities: [], builtins: [], startRole: 'guest', off: [] }

  it('mirrors the server', () => {
    expect(startRefusal(server, channel, catalog)).toBeNull()
    expect(startRefusal(server, { ...channel, e2ee: { chain: 'x' } } as unknown as Channel, catalog)).toBe('e2ee')
    expect(startRefusal(server, channel, { ...catalog, off: [5] })).toBe('off')
    expect(startRefusal(server, { ...channel, writeRole: 'trusted' }, catalog)).toBe('listen')
    expect(startRefusal(server, channel, { ...catalog, startRole: 'trusted' })).toBe('role')
    expect(startRefusal({ ...server, me: { ...me, bot: true } } as ServerState, channel, catalog)).toBe('bot')
  })

  it('lets the starter, admins, or players once the starter left end it', () => {
    const session: ActivitySession = { id: 's', channelId: 5, activity: 'four', name: null, startedBy: 'alice', startedAt: 0, players: [{ id: 'p', accountKey: 'me' }] }
    expect(mayEnd(server, session, ['alice', 'me'])).toBe(false)
    expect(mayEnd(server, session, ['me'])).toBe(true)
    expect(mayEnd(server, { ...session, players: [] }, ['me'])).toBe(false)
    expect(mayEnd(server, { ...session, startedBy: 'me' }, ['me', 'alice'])).toBe(true)
    expect(mayEnd({ ...server, me: { ...me, role: 'admin' } } as ServerState, session, ['alice'])).toBe(true)
  })
})
