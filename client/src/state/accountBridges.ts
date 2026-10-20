// Several accounts in one app: the desktop and phone shells talk to one page (the host), but each account runs in a
// frame of its own. The host lends every frame a copy of the shell's bridge that sends each shell event to the right
// account only (see platform/accountLink.ts):
// - push-to-talk, hotkeys, the screen picker, the phone's call controls: the account in voice (else the one on screen);
// - the shell's notices, the back button, the MCP bridge: the account on screen;
// - opened links (iskra:// invites, the phone's links): the account the person picks (state/accountHost.ts);
// - updates, game activity, hosted servers, bots: every account.
// The taskbar badge is the host's (every account's unread added up), so frames' own badge calls do nothing.
import type { DesktopBridge, HostedServer } from '../platform/desktop'
import type { NativeBridge } from '../platform/native'

export interface BridgeRouter {
  /** The account on screen. */
  active(): number
  /** The account in voice, if any. */
  voice(): number | null
  slots(): number[]
}

type Policy = 'all' | 'active' | 'voice'
type Listener<A extends unknown[]> = (...args: A) => void

/** One shell event, listened to once and handed to the accounts its policy picks. */
export class Hub<A extends unknown[]> {
  private readonly listeners = new Map<number, Set<Listener<A>>>()
  private detach: (() => void) | null = null
  private readonly policy: Policy | null
  private readonly router: BridgeRouter
  private readonly attach: ((fire: Listener<A>) => () => void) | null

  constructor(policy: Policy | null, router: BridgeRouter, attach: ((fire: Listener<A>) => () => void) | null) {
    this.policy = policy
    this.router = router
    this.attach = attach
  }

  subscribe(slot: number, listener: Listener<A>): () => void {
    let set = this.listeners.get(slot)
    if (!set) this.listeners.set(slot, (set = new Set()))
    set.add(listener)
    if (!this.detach && this.attach) this.detach = this.attach((...args) => this.fire(...args))
    return () => {
      set.delete(listener)
    }
  }

  hasListeners(slot: number): boolean {
    return (this.listeners.get(slot)?.size ?? 0) > 0
  }

  targets(): number[] {
    if (this.policy === 'all') return this.router.slots()
    if (this.policy === 'active') return [this.router.active()]
    if (this.policy === 'voice') return [this.router.voice() ?? this.router.active()]
    return []
  }

  fire(...args: A): void {
    for (const slot of this.targets()) this.fireTo(slot, ...args)
  }

  fireTo(slot: number, ...args: A): void {
    for (const listener of [...(this.listeners.get(slot) ?? [])]) {
      try {
        listener(...args)
      } catch (e) {
        console.warn('[iskra] account event failed', e)
      }
    }
  }

  drop(slot: number): void {
    this.listeners.delete(slot)
  }
}

type Binds = Parameters<NonNullable<DesktopBridge['setHotkeys']>>[0]

export interface Bridges {
  desktopFor(slot: number): DesktopBridge | undefined
  nativeFor(slot: number): NativeBridge | undefined
  /** Hands an opened link to an account (a desktop invite token, or a URL the phone app was opened with). */
  deliverLink(slot: number, link: { kind: 'token' | 'url'; value: string }): void
  /** The account in voice or on screen changed: global keys and the MCP bridge follow it. */
  ownerChanged(): void
  /** An account left the device (`keepLinks`: its page just reloaded; links waiting for it still go to it). */
  drop(slot: number, keepLinks?: boolean): void
}

/**
 * The per-account bridges. `onLink` gets the links the shells open (the host asks which account they're for, then
 * calls deliverLink).
 */
export function createBridges(
  real: { desktop?: DesktopBridge; native?: NativeBridge },
  router: BridgeRouter,
  onLink: (link: { kind: 'token' | 'url'; value: string }) => void,
): Bridges {
  const { desktop, native } = real
  const hub = <A extends unknown[]>(policy: Policy | null, attach?: ((fire: Listener<A>) => () => void) | null) =>
    new Hub<A>(policy, router, attach ?? null)

  const hubs = {
    ptt: hub<[boolean]>('voice', desktop && ((f) => desktop.onPushToTalk(f))),
    hotkey: hub<['mute' | 'deafen' | 'clip']>('voice', desktop?.onHotkey && ((f) => desktop.onHotkey!(f))),
    hold: hub<['whisper1' | 'whisper2' | 'whisper3' | 'priority', boolean]>('voice', desktop?.onHoldHotkey && ((f) => desktop.onHoldHotkey!(f))),
    pickScreen: hub<[Parameters<Parameters<DesktopBridge['onPickScreen']>[0]>[0]]>('voice', desktop && ((f) => desktop.onPickScreen(f))),
    notice: hub<[unknown]>('active', desktop?.notices && ((f) => desktop.notices!.onNotice(f))),
    mcp: hub<[Parameters<Parameters<NonNullable<DesktopBridge['assistant']>['onMcp']>[0]>[0]]>('active', desktop?.assistant && ((f) => desktop.assistant!.onMcp(f))),
    status: hub<[unknown]>('all', desktop && ((f) => desktop.updates.onStatus(f))),
    updating: hub<[string | null]>('all', desktop?.updates.onUpdating && ((f) => desktop.updates.onUpdating!(f))),
    activity: hub<[string | null]>('all', desktop && ((f) => desktop.onActivity(f))),
    streamer: hub<[boolean]>('all', desktop?.onStreamerProgram && ((f) => desktop.onStreamerProgram!(f))),
    p2p: hub<[{ id: string; p2p: import('../platform/desktop').P2pHostStatus }]>('all', desktop?.host.onP2p && ((f) => desktop.host.onP2p!(f))),
    bots: hub<[]>('all', desktop?.bots && ((f) => desktop.bots!.onChange(f))),
    doProgress: hub<[import('../platform/desktop').DoProgress]>('all', desktop?.digitalOcean && ((f) => desktop.digitalOcean!.onProgress(f))),
    // Delivered by the host to the account picked for it.
    deepLink: hub<[string]>(null),
    openUrl: hub<[string]>(null),
    back: hub<[]>('active', native && ((f) => native.onBackButton(f))),
    voiceEnd: hub<[]>('voice', native && ((f) => native.voice.onEnd(f))),
    voiceMute: hub<[boolean]>('voice', native && ((f) => native.voice.onMute(f))),
    voiceRoute: hub<[boolean]>('voice', native?.voice.onRoute && ((f) => native.voice.onRoute!(f))),
    // Something shared into Iskra from another app goes to the account on screen, once.
    share: hub<[unknown]>('active', native && ((f) => native.onShare(f))),
  }

  // The shells' own links come to the host first.
  if (desktop?.onDeepLink) {
    desktop.onDeepLink((token) => onLink({ kind: 'token', value: token }))
    void desktop.takeDeepLink().then((token) => token && onLink({ kind: 'token', value: token }), () => undefined)
  }
  if (native) native.onOpenUrl((url) => onLink({ kind: 'url', value: url }))

  /** Links waiting for an account whose page isn't listening yet. */
  const waiting = new Map<number, { kind: 'token' | 'url'; value: string }[]>()
  const flush = (slot: number) => {
    const list = waiting.get(slot) ?? []
    const left = list.filter((link) => {
      const h = link.kind === 'token' ? hubs.deepLink : hubs.openUrl
      if (!h.hasListeners(slot)) return true
      h.fireTo(slot, link.value)
      return false
    })
    if (left.length) waiting.set(slot, left)
    else waiting.delete(slot)
  }

  // Global keys belong to one account at a time: the one in voice, else the one on screen.
  const keys = new Map<number, { ptt?: number | null; hotkeys?: Binds }>()
  let applied: { owner: number; ptt: number | null; hotkeys: string } | null = null
  const keyOwner = () => router.voice() ?? router.active()
  const applyKeys = () => {
    if (!desktop) return
    const owner = keyOwner()
    const mine = keys.get(owner) ?? {}
    const ptt = mine.ptt ?? null
    const hotkeys = JSON.stringify(mine.hotkeys ?? {})
    if (applied && applied.ptt === ptt && applied.hotkeys === hotkeys) return
    applied = { owner, ptt, hotkeys }
    void desktop.setPushToTalkKey(ptt).catch(() => undefined)
    void desktop.setHotkeys?.(mine.hotkeys ?? {}).catch(() => undefined)
  }

  // The MCP bridge serves the account on screen; the assistant's provider address is each account's own.
  // When another account comes on screen, a connected MCP client is dropped (the bridge stops) and has to connect
  // again: it never carries on as a different account without the person approving its calls there.
  const mcp = new Map<number, boolean>()
  let mcpApplied: boolean | null = null
  let mcpOwner: number | null = null
  const applyMcp = async (): Promise<{ on: boolean; command: string[] | null } | null> => {
    const assistant = desktop?.assistant
    if (!assistant) return null
    const owner = router.active()
    const on = mcp.get(owner) ?? false
    if (mcpApplied === on && (mcpOwner === owner || !on)) return null
    if (mcpApplied && mcpOwner !== owner) await assistant.setMcp(false).catch(() => null)
    mcpApplied = on
    mcpOwner = owner
    return assistant.setMcp(on).catch(() => null)
  }
  const bases = new Map<number, string | null>()
  let baseApplied: string | null | undefined
  // The provider address is the shell's one setting: setting it and sending under it go one at a time, so one
  // account's request never goes out under another account's address.
  let assistantQueue: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = assistantQueue.then(work, work)
    assistantQueue = next.catch(() => undefined)
    return next
  }
  const applyBase = async (slot: number): Promise<{ ok: true } | { ok: false; error: 'refused' | 'invalid' }> => {
    const base = bases.get(slot) ?? null
    if (baseApplied === base) return { ok: true }
    const reply = (await desktop?.assistant?.setBase?.(base).catch(() => null)) ?? { ok: true as const }
    if (reply.ok) baseApplied = base
    return reply
  }

  // A tunnel to a server is the device's: two accounts on the same server share it, so it closes when neither uses it.
  const tunnels = new Map<string, Set<number>>()

  // Servers hosted on this computer belong to the device; the owner invite of one made by an account here is only
  // that account's (another account on the device sees the server, not its one-time owner link).
  const createdBy = new Map<string, number>()
  function hostFor(slot: number): DesktopBridge['host'] {
    const real = desktop!.host
    const mine = (server: HostedServer | null): HostedServer | null => {
      if (!server) return server
      const owner = createdBy.get(server.id)
      return owner !== undefined && owner !== slot ? { ...server, ownerInvite: null } : server
    }
    const made = (server: HostedServer | null): HostedServer | null => {
      if (server) createdBy.set(server.id, slot)
      return server
    }
    return {
      ...real,
      list: async () => (await real.list()).map((s) => mine(s)!),
      create: async (name, appUrl, template) => made(await real.create(name, appUrl, template)),
      start: async (id) => mine(await real.start(id)),
      stop: async (id) => mine(await real.stop(id)),
      ...(real.keepRunning ? { keepRunning: async (id: string, on: boolean) => mine(await real.keepRunning!(id, on)) } : {}),
      ...(real.p2pSync ? { p2pSync: async (id: string) => mine(await real.p2pSync!(id)) } : {}),
      ...(real.restore ? { restore: async (path: string, passphrase: string) => {
        const restored = await real.restore!(path, passphrase)
        made(restored.server)
        return restored
      } } : {}),
      ...(real.restoreBuddy ? { restoreBuddy: async (address: string, code: string) => {
        const restored = await real.restoreBuddy!(address, code)
        made(restored.server)
        return restored
      } } : {}),
      ...(real.onP2p ? { onP2p: (callback: Parameters<NonNullable<DesktopBridge['host']['onP2p']>>[0]) => hubs.p2p.subscribe(slot, callback) } : {}),
    }
  }

  const desktops = new Map<number, DesktopBridge>()
  function desktopFor(slot: number): DesktopBridge | undefined {
    if (!desktop) return undefined
    const existing = desktops.get(slot)
    if (existing) return existing
    const on = <A extends unknown[]>(h: Hub<A>) => (callback: Listener<A>) => h.subscribe(slot, callback)
    const bridge: DesktopBridge = {
      ...desktop,
      setPushToTalkKey: async (keycode) => {
        keys.set(slot, { ...keys.get(slot), ptt: keycode })
        applyKeys()
      },
      onPushToTalk: on(hubs.ptt),
      ...(desktop.setHotkeys ? {
        setHotkeys: async (binds: Binds) => {
          keys.set(slot, { ...keys.get(slot), hotkeys: binds })
          applyKeys()
        },
      } : {}),
      ...(desktop.onHotkey ? { onHotkey: on(hubs.hotkey) } : {}),
      ...(desktop.onHoldHotkey ? { onHoldHotkey: on(hubs.hold) } : {}),
      ...(desktop.notices ? { notices: { ...desktop.notices, onNotice: on(hubs.notice) } } : {}),
      updates: {
        ...desktop.updates,
        onStatus: on(hubs.status),
        ...(desktop.updates.onUpdating ? { onUpdating: on(hubs.updating) } : {}),
      },
      onPickScreen: on(hubs.pickScreen),
      // The host shows every account's unread on the taskbar.
      setBadge: async () => undefined,
      takeDeepLink: async () => null,
      onDeepLink: (callback) => {
        const stop = hubs.deepLink.subscribe(slot, callback)
        queueMicrotask(() => flush(slot))
        return stop
      },
      onActivity: on(hubs.activity),
      ...(desktop.onStreamerProgram ? { onStreamerProgram: on(hubs.streamer) } : {}),
      host: hostFor(slot),
      ...(desktop.p2p ? {
        p2p: {
          ...desktop.p2p,
          open: async (serverKey: string, secret: string) => {
            const users = tunnels.get(serverKey) ?? new Set<number>()
            users.add(slot)
            tunnels.set(serverKey, users)
            return desktop.p2p!.open(serverKey, secret)
          },
          close: async (serverKey: string) => {
            const users = tunnels.get(serverKey)
            users?.delete(slot)
            if (users?.size) return
            tunnels.delete(serverKey)
            return desktop.p2p!.close(serverKey)
          },
        },
      } : {}),
      ...(desktop.bots ? { bots: { ...desktop.bots, onChange: on(hubs.bots) } } : {}),
      ...(desktop.digitalOcean ? { digitalOcean: { ...desktop.digitalOcean, onProgress: on(hubs.doProgress) } } : {}),
      ...(desktop.assistant ? {
        assistant: {
          ...desktop.assistant,
          onMcp: on(hubs.mcp),
          setMcp: async (value: boolean) => {
            mcp.set(slot, value)
            if (slot !== router.active()) return { on: false, command: null }
            if (mcpOwner === slot) mcpApplied = null
            return (await applyMcp()) ?? { on: false, command: null }
          },
          setBase: (base: string | null) => {
            bases.set(slot, base)
            return inTurn(() => applyBase(slot))
          },
          fetch: (request: Parameters<NonNullable<DesktopBridge['assistant']>['fetch']>[0]) => inTurn(async () => {
            await applyBase(slot)
            return desktop.assistant!.fetch(request)
          }),
        },
      } : {}),
    }
    desktops.set(slot, bridge)
    return bridge
  }

  const natives = new Map<number, NativeBridge>()
  function nativeFor(slot: number): NativeBridge | undefined {
    if (!native) return undefined
    const existing = natives.get(slot)
    if (existing) return existing
    const bridge: NativeBridge = {
      ...native,
      onOpenUrl: (callback) => {
        const stop = hubs.openUrl.subscribe(slot, callback)
        queueMicrotask(() => flush(slot))
        return stop
      },
      onBackButton: (callback) => hubs.back.subscribe(slot, callback),
      onShare: (callback) => hubs.share.subscribe(slot, callback),
      // Every account's theme is the device's, so any of them may set it; the one on screen is what shows.
      setStatusBar: (scheme) => (slot === router.active() ? native.setStatusBar(scheme) : Promise.resolve()),
      voice: {
        ...native.voice,
        onEnd: (callback) => hubs.voiceEnd.subscribe(slot, callback),
        onMute: (callback) => hubs.voiceMute.subscribe(slot, callback),
        ...(native.voice.onRoute && { onRoute: (callback: (headset: boolean) => void) => hubs.voiceRoute.subscribe(slot, callback) }),
      },
    }
    natives.set(slot, bridge)
    return bridge
  }

  return {
    desktopFor,
    nativeFor,
    deliverLink(slot, link) {
      waiting.set(slot, [...(waiting.get(slot) ?? []), link])
      flush(slot)
    },
    ownerChanged() {
      applyKeys()
      void applyMcp()
    },
    drop(slot, keepLinks = false) {
      for (const h of Object.values(hubs)) h.drop(slot)
      if (!keepLinks) waiting.delete(slot)
      keys.delete(slot)
      mcp.delete(slot)
      if (!keepLinks) {
        for (const [serverKey, users] of tunnels) {
          if (!users.delete(slot) || users.size) continue
          tunnels.delete(serverKey)
          void desktop?.p2p?.close(serverKey).catch(() => undefined)
        }
      }
      bases.delete(slot)
      desktops.delete(slot)
      natives.delete(slot)
      applyKeys()
    },
  }
}
