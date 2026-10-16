import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureTargets, type PopoutTarget } from '../popoutLogic'
import { CAPTURE_DELAY_SECONDS, pngFromDataUrl, reportOpenAction, startCountdown } from './reportWindow'

describe('opening the bug report', () => {
  it('opens a window where there can be one, else in the page', () => {
    expect(reportOpenAction({ windowOpen: false, dialogOpen: false, touch: false, mode: 'window' })).toBe('window')
    expect(reportOpenAction({ windowOpen: false, dialogOpen: false, touch: false, mode: 'document' })).toBe('window')
    expect(reportOpenAction({ windowOpen: false, dialogOpen: false, touch: false, mode: null })).toBe('dialog')
    expect(reportOpenAction({ windowOpen: false, dialogOpen: false, touch: false, mode: 'video' })).toBe('dialog')
  })

  it('touch screens get it in the page, except in the desktop app', () => {
    expect(reportOpenAction({ windowOpen: false, dialogOpen: false, touch: true, mode: 'document' })).toBe('dialog')
    expect(reportOpenAction({ windowOpen: false, dialogOpen: false, touch: true, mode: 'window' })).toBe('window')
  })

  it('one report at a time: again brings it up', () => {
    expect(reportOpenAction({ windowOpen: true, dialogOpen: false, touch: false, mode: 'window' })).toBe('focus')
    expect(reportOpenAction({ windowOpen: false, dialogOpen: true, touch: false, mode: null })).toBe('none')
  })
})

describe('screenshot countdown', () => {
  afterEach(() => vi.useRealTimers())

  it('ticks down every second, then takes it', () => {
    vi.useFakeTimers()
    const ticks: number[] = []
    const done = vi.fn()
    startCountdown(CAPTURE_DELAY_SECONDS, (left) => ticks.push(left), done)
    expect(ticks).toEqual([5])
    vi.advanceTimersByTime(4000)
    expect(ticks).toEqual([5, 4, 3, 2, 1])
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(done).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('can be cancelled', () => {
    vi.useFakeTimers()
    const done = vi.fn()
    const cancel = startCountdown(3, () => {}, done)
    vi.advanceTimersByTime(1500)
    cancel()
    vi.advanceTimersByTime(10_000)
    expect(done).not.toHaveBeenCalled()
  })
})

describe('capture targets', () => {
  const p = (id: string, target: PopoutTarget, mode = 'window') => ({ id, target, mode })

  it('the desktop pop-out windows, never the report itself', () => {
    const open = [
      p('iskra-popout-voice-1', { kind: 'voice' }),
      p('iskra-popout-report-2', { kind: 'report' }),
      p('iskra-popout-chat-3', { kind: 'chat', serverKey: 's', channelId: 1 }),
      p('iskra-popout-stream-4', { kind: 'stream', tileId: 't' }),
    ]
    expect(captureTargets(open).map((x) => x.id)).toEqual(['iskra-popout-voice-1', 'iskra-popout-chat-3', 'iskra-popout-stream-4'])
  })

  it('nothing from the browser’s picture-in-picture', () => {
    expect(captureTargets([p('pip-1', { kind: 'voice' }, 'document')])).toEqual([])
  })
})

describe('captured pictures', () => {
  it('only PNG data URLs', async () => {
    const blob = pngFromDataUrl(`data:image/png;base64,${btoa('png!')}`)
    expect(blob?.type).toBe('image/png')
    expect(await blob?.text()).toBe('png!')
    for (const bad of [null, undefined, 42, '', 'data:image/jpeg;base64,AAAA', 'https://example.com/a.png', 'data:image/png;base64,%%%']) {
      expect(pngFromDataUrl(bad)).toBeNull()
    }
  })
})
