import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

// resume.ts against stand-ins for the voice room and the server list: what matters is when it calls rejoinVoice.
const voice = vi.hoisted(() => ({
  dropped: [] as ((where: unknown) => void)[],
  left: [] as (() => void)[],
  rejoin: vi.fn<(where: unknown) => Promise<boolean>>(async () => true),
}))

vi.mock('./store', () => ({
  connectionFor: () => ({ isOnline: true }),
  onServerEvent: () => () => undefined,
  onWelcomeHook: () => () => undefined,
  useApp: create(() => ({ servers: { s1: { voiceAvailable: true, status: { state: 'online' } } } })),
}))
vi.mock('./voice', async () => {
  const { create } = await import('zustand')
  const useVoice = create(() => ({ session: null as null | { state: string } }))
  return {
    useVoice,
    clearVoiceResume: () => undefined,
    currentVoice: () => null,
    leaveVoice: async () => voice.left.forEach((l) => l()),
    onVoiceDropped: (l: (where: unknown) => void) => voice.dropped.push(l),
    onVoiceLeft: (l: () => void) => voice.left.push(l),
    pauseVoiceFor: async () => undefined,
    rejoinVoice: (where: unknown) => voice.rejoin(where),
    resyncVoiceFlags: () => undefined,
    voiceConnected: () => false,
    voiceResume: () => null,
  }
})

const where = { serverKey: 's1', channelId: 2, camera: false, screen: false, stageOpen: false, at: 0 }
const drop = () => voice.dropped.forEach((l) => l(where))
const leave = () => voice.left.forEach((l) => l())

describe('getting back into voice after the room dropped', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    await import('./resume')
    voice.rejoin.mockReset()
  })
  afterEach(() => {
    leave() // nothing carries over to the next test
    vi.useRealTimers()
  })

  it('rejoins a moment after a drop', async () => {
    voice.rejoin.mockResolvedValue(true)
    drop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(voice.rejoin).toHaveBeenCalledTimes(1)
  })

  it('never rejoins after you left on purpose', async () => {
    drop()
    leave()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(voice.rejoin).not.toHaveBeenCalled()
  })

  it("doesn't try again when you left while a rejoin was under way", async () => {
    let finish: (ok: boolean) => void = () => undefined
    voice.rejoin.mockImplementation(() => new Promise<boolean>((r) => (finish = r)))
    drop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(voice.rejoin).toHaveBeenCalledTimes(1)
    leave()
    finish(false) // the join stopped because you left
    await vi.advanceTimersByTimeAsync(10_000)
    expect(voice.rejoin).toHaveBeenCalledTimes(1)
  })

  it('tries again when a rejoin fails and you stayed', async () => {
    voice.rejoin.mockResolvedValueOnce(false).mockResolvedValue(true)
    drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(voice.rejoin).toHaveBeenCalledTimes(2)
  })
})
