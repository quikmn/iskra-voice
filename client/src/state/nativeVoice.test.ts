// The phone app's speaker button (Android): each call starts on the speaker once connected, the button flips it, and it
// hides while a headset is in. Its list: what the call can play on, and picking one.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

const fake = vi.hoisted(() => {
  const routes = new Set<(headset: boolean) => void>()
  return {
    routes,
    headset: false,
    voice: {
      start: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      keepAwake: vi.fn(async (_on: boolean) => undefined),
      onEnd: vi.fn(() => () => undefined),
      onMute: vi.fn(() => () => undefined),
      speaker: vi.fn(async (_on: boolean) => ({ headset: false })),
      onRoute: vi.fn((cb: (headset: boolean) => void) => {
        routes.add(cb)
        return () => routes.delete(cb)
      }),
    },
  }
})

vi.mock('../platform/native', () => ({ native: { platform: 'android', voice: fake.voice } }))
vi.mock('./dms', () => ({ nameOf: () => 'Someone' }))
vi.mock('./store', () => ({ useApp: { getState: () => ({ servers: {} }) } }))
vi.mock('./voice', () => ({
  useVoice: create<{ session: unknown; camera: boolean; muted: boolean }>(() => ({ session: null, camera: false, muted: false })),
  leaveVoice: vi.fn(),
  toggleMute: vi.fn(),
}))

const { pickRoute, startNativeVoice, toggleSpeaker, useSpeaker } = await import('./nativeVoice')
const { useVoice } = await import('./voice')

const session = (state: 'connecting' | 'connected' | 'reconnecting') => ({ serverKey: 's', channelId: 1, state, canSpeak: true })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the speaker button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useVoice.setState({ session: null })
    useSpeaker.setState({ shown: false, on: true, routes: [], route: null })
    delete (fake.voice as { routes?: unknown }).routes
    delete (fake.voice as { route?: unknown }).route
  })

  it('starts each call on the speaker once connected, and flips to the earpiece and back', async () => {
    const stop = startNativeVoice()
    useVoice.setState({ session: session('connecting') })
    expect(fake.voice.start).toHaveBeenCalledOnce()
    expect(fake.voice.speaker).not.toHaveBeenCalled()
    useVoice.setState({ session: session('connected') })
    await settle()
    expect(fake.voice.speaker).toHaveBeenLastCalledWith(true)
    expect(useSpeaker.getState()).toEqual({ shown: true, on: true, routes: [], route: null })

    toggleSpeaker()
    await settle()
    expect(fake.voice.speaker).toHaveBeenLastCalledWith(false)
    expect(useSpeaker.getState().on).toBe(false)

    // A reconnect keeps the choice.
    useVoice.setState({ session: session('reconnecting') })
    useVoice.setState({ session: session('connected') })
    await settle()
    expect(fake.voice.speaker).toHaveBeenLastCalledWith(false)

    useVoice.setState({ session: null })
    expect(useSpeaker.getState().shown).toBe(false)
    // The next call is on the speaker again.
    useVoice.setState({ session: { ...session('connected'), channelId: 2 } })
    await settle()
    expect(fake.voice.speaker).toHaveBeenLastCalledWith(true)
    stop()
  })

  it('keeps the screen on while your camera is on in a call', () => {
    const stop = startNativeVoice()
    useVoice.setState({ session: session('connected'), camera: false })
    expect(fake.voice.keepAwake).not.toHaveBeenCalled()
    useVoice.setState({ camera: true })
    expect(fake.voice.keepAwake).toHaveBeenLastCalledWith(true)
    useVoice.setState({ camera: false })
    expect(fake.voice.keepAwake).toHaveBeenLastCalledWith(false)
    useVoice.setState({ camera: true })
    useVoice.setState({ session: null, camera: false })
    expect(fake.voice.keepAwake).toHaveBeenLastCalledWith(false)
    expect(fake.voice.keepAwake).toHaveBeenCalledTimes(4)
    stop()
  })

  it('hides while a headset is in', async () => {
    const stop = startNativeVoice()
    fake.voice.speaker.mockResolvedValueOnce({ headset: true })
    useVoice.setState({ session: session('connected') })
    await settle()
    expect(useSpeaker.getState().shown).toBe(false)
    fake.routes.forEach((cb) => cb(false))
    expect(useSpeaker.getState().shown).toBe(true)
    fake.routes.forEach((cb) => cb(true))
    expect(useSpeaker.getState().shown).toBe(false)
    stop()
    expect(fake.routes.size).toBe(0)
  })

  it('lists what the call can play on, plays on the one picked, and keeps it over a reconnect', async () => {
    const phone = [{ id: 3, kind: 'speaker', name: 'Phone' }, { id: 2, kind: 'earpiece', name: 'Phone' }]
    const withHeadset = [...phone, { id: 7, kind: 'bluetooth', name: 'Buds' }]
    let current = 3
    let list = phone
    const voice = fake.voice as typeof fake.voice & { routes?: () => Promise<unknown>; route?: (id: number) => Promise<unknown> }
    voice.routes = vi.fn(async () => ({ routes: list, current }))
    voice.route = vi.fn(async (id: number) => {
      current = id
      return { routes: list, current }
    })
    const stop = startNativeVoice()
    useVoice.setState({ session: session('connected') })
    await settle()
    await settle()
    expect(useSpeaker.getState().routes.map((r) => r.kind)).toEqual(['speaker', 'earpiece'])
    expect(useSpeaker.getState().route).toBe(3)

    // The earpiece from the list: the button shows it too.
    pickRoute(2)
    await settle()
    expect(voice.route).toHaveBeenLastCalledWith(2)
    expect(useSpeaker.getState()).toMatchObject({ route: 2, on: false })

    // A headset comes: the list is asked for again.
    list = withHeadset
    fake.routes.forEach((cb) => cb(true))
    await settle()
    expect(useSpeaker.getState().routes.map((r) => r.name)).toEqual(['Phone', 'Phone', 'Buds'])
    pickRoute(7)
    await settle()
    expect(useSpeaker.getState().route).toBe(7)

    // A reconnect plays on the picked one again, not on the button's choice.
    fake.voice.speaker.mockClear()
    useVoice.setState({ session: session('reconnecting') })
    useVoice.setState({ session: session('connected') })
    await settle()
    expect(voice.route).toHaveBeenLastCalledWith(7)
    expect(fake.voice.speaker).not.toHaveBeenCalled()

    // The button goes back to the phone's own speaker or earpiece.
    toggleSpeaker()
    await settle()
    expect(fake.voice.speaker).toHaveBeenCalledOnce()

    useVoice.setState({ session: null })
    expect(useSpeaker.getState()).toMatchObject({ routes: [], route: null })
    stop()
  })

  it('an app that cannot list them keeps the plain button', async () => {
    const voice = fake.voice as typeof fake.voice & { routes?: () => Promise<unknown> }
    voice.routes = vi.fn(async () => { throw new Error('"IskraNative.voiceRoutes()" is not implemented on android') })
    const stop = startNativeVoice()
    useVoice.setState({ session: session('connected') })
    await settle()
    await settle()
    expect(useSpeaker.getState()).toEqual({ shown: true, on: true, routes: [], route: null })
    stop()
  })
})
