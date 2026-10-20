// The phone app's speaker button (Android): each call starts on the speaker once connected, the button flips it, and it
// hides while a headset is in.
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

const { startNativeVoice, toggleSpeaker, useSpeaker } = await import('./nativeVoice')
const { useVoice } = await import('./voice')

const session = (state: 'connecting' | 'connected' | 'reconnecting') => ({ serverKey: 's', channelId: 1, state, canSpeak: true })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the speaker button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useVoice.setState({ session: null })
    useSpeaker.setState({ shown: false, on: true })
  })

  it('starts each call on the speaker once connected, and flips to the earpiece and back', async () => {
    const stop = startNativeVoice()
    useVoice.setState({ session: session('connecting') })
    expect(fake.voice.start).toHaveBeenCalledOnce()
    expect(fake.voice.speaker).not.toHaveBeenCalled()
    useVoice.setState({ session: session('connected') })
    await settle()
    expect(fake.voice.speaker).toHaveBeenLastCalledWith(true)
    expect(useSpeaker.getState()).toEqual({ shown: true, on: true })

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
})
