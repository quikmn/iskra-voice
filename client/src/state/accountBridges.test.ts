// The desktop and phone shells as each account's page sees them: every shell event reaches the right account only.
import { describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../platform/desktop'
import type { NativeBridge } from '../platform/native'
import { createBridges, type BridgeRouter } from './accountBridges'

/** A shell whose events the test fires by name. */
function fakeShells() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const on = (name: string) => vi.fn((cb: (...args: unknown[]) => void) => {
    const set = listeners.get(name) ?? new Set()
    set.add(cb)
    listeners.set(name, set)
    return () => set.delete(cb)
  })
  const fire = (name: string, ...args: unknown[]) => listeners.get(name)?.forEach((cb) => cb(...args))
  const desktop = {
    platform: 'win32',
    setPushToTalkKey: vi.fn(async () => undefined),
    setHotkeys: vi.fn(async () => undefined),
    onPushToTalk: on('ptt'),
    onHotkey: on('hotkey'),
    onPickScreen: on('pick'),
    onActivity: on('activity'),
    onDeepLink: on('deep'),
    takeDeepLink: vi.fn(async () => 'started-with'),
    setBadge: vi.fn(async () => undefined),
    keychain: { status: vi.fn(async () => 'keyring'), encrypt: vi.fn(async (s: string) => `enc:${s}`), decrypt: vi.fn(async () => null) },
    notices: { onNotice: on('notice'), act: vi.fn(async () => undefined) },
    updates: { status: vi.fn(async () => ({})), onStatus: on('status'), restart: vi.fn(async () => true) },
    host: {
      available: vi.fn(async () => true),
      list: vi.fn(async () => [{ id: 'w1', ownerInvite: 'http://x/#/join/owner' }, { id: 'w0', ownerInvite: 'http://y/#/join/old' }]),
      create: vi.fn(async () => ({ id: 'w1', ownerInvite: 'http://x/#/join/owner' })),
      start: vi.fn(async () => ({ id: 'w1', ownerInvite: 'http://x/#/join/owner' })),
      stop: vi.fn(async () => null),
    },
    p2p: { open: vi.fn(async () => ({ url: 'http://127.0.0.1:1', turnPort: 2 })), close: vi.fn(async () => undefined) },
    assistant: {
      fetch: vi.fn(async () => ({ ok: true as const, status: 200, body: '' })),
      setBase: vi.fn(async () => ({ ok: true as const })),
      setMcp: vi.fn(async (on: boolean) => ({ on, command: on ? ['iskra'] : null })),
      onMcp: on('mcp'),
      mcpReply: vi.fn(async () => undefined),
    },
  } as unknown as DesktopBridge
  const native = {
    platform: 'android',
    onOpenUrl: on('url'),
    onBackButton: on('back'),
    setStatusBar: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => true),
    leave: vi.fn(),
    voice: { start: vi.fn(async () => undefined), update: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), onEnd: on('voiceEnd'), onMute: on('voiceMute') },
  } as unknown as NativeBridge
  return { desktop, native, fire }
}

function setUp() {
  const shells = fakeShells()
  const state = { active: 1, voice: null as number | null, slots: [1, 2, 3] }
  const router: BridgeRouter = { active: () => state.active, voice: () => state.voice, slots: () => state.slots }
  const links: unknown[] = []
  const bridges = createBridges({ desktop: shells.desktop, native: shells.native }, router, (link) => links.push(link))
  return { ...shells, state, bridges, links }
}

const heard = () => {
  const got: Record<number, unknown[]> = {}
  return { got, for: (slot: number) => (...args: unknown[]) => void (got[slot] ??= []).push(args.length > 1 ? args : args[0]) }
}

describe("each account's copy of the shell", () => {
  it('sends push-to-talk and hotkeys to the account in voice, else the one on screen', () => {
    const { fire, state, bridges } = setUp()
    const h = heard()
    for (const slot of [1, 2, 3]) {
      bridges.desktopFor(slot)!.onPushToTalk(h.for(slot))
      bridges.desktopFor(slot)!.onHotkey!(h.for(slot))
    }
    fire('ptt', true)
    expect(h.got).toEqual({ 1: [true] })
    state.voice = 3
    fire('hotkey', 'mute')
    expect(h.got[3]).toEqual(['mute'])
    expect(h.got[2]).toBeUndefined()
  })

  it('sends the shell notices to the account on screen, and updates and game activity to all', () => {
    const { fire, state, bridges } = setUp()
    const notices = heard()
    const status = heard()
    for (const slot of [1, 2, 3]) {
      bridges.desktopFor(slot)!.notices!.onNotice(notices.for(slot))
      bridges.desktopFor(slot)!.updates.onStatus(status.for(slot))
      bridges.desktopFor(slot)!.onActivity(status.for(slot))
    }
    state.active = 2
    fire('notice', { kind: 'about' })
    expect(notices.got).toEqual({ 2: [{ kind: 'about' }] })
    fire('status', 'ready')
    fire('activity', 'Chess')
    expect(status.got).toEqual({ 1: ['ready', 'Chess'], 2: ['ready', 'Chess'], 3: ['ready', 'Chess'] })
  })

  it("hands opened links to the host first, then only to the account picked, even before its page listens", async () => {
    const { fire, bridges, links, desktop } = setUp()
    await vi.waitFor(() => expect(links).toEqual([{ kind: 'token', value: 'started-with' }]))
    fire('deep', 'tok')
    expect(links.at(-1)).toEqual({ kind: 'token', value: 'tok' })
    // Pages never take the shell's start link themselves.
    expect(await bridges.desktopFor(2)!.takeDeepLink()).toBeNull()
    expect(desktop.takeDeepLink).toHaveBeenCalledTimes(1)
    bridges.deliverLink(2, { kind: 'token', value: 'tok' })
    const got: string[] = []
    bridges.desktopFor(1)!.onDeepLink((t) => got.push(`1:${t}`))
    bridges.desktopFor(2)!.onDeepLink((t) => got.push(`2:${t}`))
    await Promise.resolve()
    expect(got).toEqual(['2:tok'])
    // The phone's links likewise.
    fire('url', 'https://app.iskra.foo/#/join/x')
    expect(links.at(-1)).toEqual({ kind: 'url', value: 'https://app.iskra.foo/#/join/x' })
    const urls: string[] = []
    bridges.nativeFor(3)!.onOpenUrl((u) => urls.push(u))
    bridges.deliverLink(3, { kind: 'url', value: 'https://app.iskra.foo/#/join/x' })
    expect(urls).toEqual(['https://app.iskra.foo/#/join/x'])
  })

  it("leaves the taskbar badge to the host, which adds every account's unread", async () => {
    const { bridges, desktop } = setUp()
    await bridges.desktopFor(2)!.setBadge(5, null)
    expect(desktop.setBadge).not.toHaveBeenCalled()
  })

  it("sets the global keys of the account in voice (else on screen) and follows when that changes", async () => {
    const { bridges, state, desktop } = setUp()
    await bridges.desktopFor(1)!.setPushToTalkKey(30)
    await bridges.desktopFor(2)!.setPushToTalkKey(31)
    expect(desktop.setPushToTalkKey).toHaveBeenLastCalledWith(30)
    state.voice = 2
    bridges.ownerChanged()
    expect(desktop.setPushToTalkKey).toHaveBeenLastCalledWith(31)
    state.voice = 3
    bridges.ownerChanged()
    expect(desktop.setPushToTalkKey).toHaveBeenLastCalledWith(null) // account 3 has no push-to-talk key
  })

  it('serves the MCP bridge for the account on screen only, and drops its client when that account changes', async () => {
    const { bridges, state, desktop } = setUp()
    const setMcp = desktop.assistant!.setMcp as ReturnType<typeof vi.fn>
    expect(await bridges.desktopFor(2)!.assistant!.setMcp(true)).toEqual({ on: false, command: null })
    expect(setMcp).not.toHaveBeenCalled()
    state.active = 2
    bridges.ownerChanged()
    await vi.waitFor(() => expect(setMcp).toHaveBeenLastCalledWith(true))
    expect(await bridges.desktopFor(1)!.assistant!.setMcp(false)).toEqual({ on: false, command: null })
    // Security review L9: account 3 (MCP on too) comes on screen: the bridge stops (clients drop) and starts again.
    await bridges.desktopFor(3)!.assistant!.setMcp(true)
    setMcp.mockClear()
    state.active = 3
    bridges.ownerChanged()
    await vi.waitFor(() => expect(setMcp.mock.calls).toEqual([[false], [true]]))
  })

  it("never sends one account's assistant request under another account's provider address", async () => {
    const { bridges, desktop } = setUp()
    const log: string[] = []
    let release!: () => void
    ;(desktop.assistant!.setBase as ReturnType<typeof vi.fn>).mockImplementation(async (base: string | null) => {
      log.push(`base ${base}`)
      return { ok: true }
    })
    ;(desktop.assistant!.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (r: { url: string }) => {
      log.push(`fetch ${r.url}`)
      if (r.url === 'a') await new Promise<void>((done) => (release = done))
      return { ok: true, status: 200, body: '' }
    })
    await bridges.desktopFor(1)!.assistant!.setBase!('https://one')
    await bridges.desktopFor(2)!.assistant!.setBase!('https://two')
    const a = bridges.desktopFor(1)!.assistant!.fetch({ url: 'a', method: 'GET', headers: {} })
    const b = bridges.desktopFor(2)!.assistant!.fetch({ url: 'b', method: 'GET', headers: {} })
    await vi.waitFor(() => expect(log.at(-1)).toBe('fetch a'))
    release()
    await Promise.all([a, b])
    expect(log).toEqual(['base https://one', 'base https://two', 'base https://one', 'fetch a', 'base https://two', 'fetch b'])
  })

  it('keeps a shared tunnel open while any account on that server uses it', async () => {
    const { bridges, desktop } = setUp()
    await bridges.desktopFor(1)!.p2p!.open('S', 'x')
    await bridges.desktopFor(2)!.p2p!.open('S', 'x')
    await bridges.desktopFor(1)!.p2p!.close('S')
    expect(desktop.p2p!.close).not.toHaveBeenCalled()
    bridges.drop(2)
    expect(desktop.p2p!.close).toHaveBeenCalledWith('S')
  })

  it("routes the phone's back button to the account on screen and its call controls to the one in voice", () => {
    const { fire, state, bridges, native } = setUp()
    const backs = heard()
    const ends = heard()
    for (const slot of [1, 2]) {
      bridges.nativeFor(slot)!.onBackButton(backs.for(slot))
      bridges.nativeFor(slot)!.voice.onEnd(ends.for(slot))
    }
    state.active = 2
    state.voice = 1
    fire('back')
    fire('voiceEnd')
    expect(backs.got).toEqual({ 2: [undefined] })
    expect(ends.got).toEqual({ 1: [undefined] })
    void bridges.nativeFor(1)!.setStatusBar('light')
    expect(native.setStatusBar).not.toHaveBeenCalled()
    void bridges.nativeFor(2)!.setStatusBar('light')
    expect(native.setStatusBar).toHaveBeenCalledWith('light')
  })

  it("keeps a hosted server's owner invite to the account that made it", async () => {
    const { bridges } = setUp()
    expect((await bridges.desktopFor(1)!.host.create('W', 'http://app'))?.ownerInvite).toBe('http://x/#/join/owner')
    expect((await bridges.desktopFor(2)!.host.start('w1'))?.ownerInvite).toBeNull()
    expect((await bridges.desktopFor(2)!.host.list()).map((s) => s.ownerInvite)).toEqual([null, 'http://y/#/join/old'])
    expect((await bridges.desktopFor(1)!.host.list())[0].ownerInvite).toBe('http://x/#/join/owner')
  })

  it("forgets an account's listeners when it leaves", () => {
    const { fire, bridges } = setUp()
    const h = heard()
    bridges.desktopFor(1)!.updates.onStatus(h.for(1))
    bridges.drop(1)
    fire('status', 'x')
    expect(h.got).toEqual({})
  })
})
