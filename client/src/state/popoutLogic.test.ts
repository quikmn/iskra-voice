import { describe, expect, it } from 'vitest'
import { popoutMode, popoutName, stalePopouts, targetKey, type PopoutEnv } from './popoutLogic'

const env = (over: Partial<PopoutEnv> = {}): PopoutEnv => ({ desktopWindows: false, documentPip: false, videoPip: false, phoneApp: false, ...over })

describe('how a pop-out opens', () => {
  it('desktop app: a window of its own, for all three', () => {
    for (const kind of ['voice', 'stream', 'chat'] as const) expect(popoutMode(kind, env({ desktopWindows: true, documentPip: true, videoPip: true }))).toBe('window')
  })

  it('Chromium: Document Picture-in-Picture for voice and streams, nothing for a channel', () => {
    const chrome = env({ documentPip: true, videoPip: true })
    expect(popoutMode('voice', chrome)).toBe('document')
    expect(popoutMode('stream', chrome)).toBe('document')
    expect(popoutMode('chat', chrome)).toBeNull()
  })

  it("without Document PiP: a video's own picture-in-picture for streams; the voice panel can't", () => {
    const safari = env({ videoPip: true })
    expect(popoutMode('stream', safari)).toBe('video')
    expect(popoutMode('voice', safari)).toBeNull()
    expect(popoutMode('chat', safari)).toBeNull()
  })

  it('neither (Firefox without PiP API, old browsers): no buttons', () => {
    for (const kind of ['voice', 'stream', 'chat'] as const) expect(popoutMode(kind, env())).toBeNull()
  })

  it('the bug report: a window on desktop, Document PiP in Chromium, else in the page', () => {
    expect(popoutMode('report', env({ desktopWindows: true }))).toBe('window')
    expect(popoutMode('report', env({ documentPip: true, videoPip: true }))).toBe('document')
    expect(popoutMode('report', env({ videoPip: true }))).toBeNull()
    expect(popoutMode('report', env())).toBeNull()
  })

  it('phone apps: none, whatever the web view claims', () => {
    for (const kind of ['voice', 'stream', 'chat', 'report'] as const) expect(popoutMode(kind, env({ phoneApp: true, documentPip: true, videoPip: true }))).toBeNull()
  })
})

describe('names and keys', () => {
  it('window names match what the desktop shell accepts', () => {
    expect(popoutName('voice', 1)).toBe('iskra-popout-voice-1')
    expect(popoutName('stream', 36)).toBe('iskra-popout-stream-10')
    expect(popoutName('chat', 123456)).toMatch(/^iskra-popout-chat-[a-z0-9]{1,24}$/)
  })

  it('one pop-out per thing', () => {
    expect(targetKey({ kind: 'voice' })).toBe('voice')
    expect(targetKey({ kind: 'stream', tileId: 'abc:TR_1' })).toBe('stream:abc:TR_1')
    expect(targetKey({ kind: 'chat', serverKey: 'k', channelId: 7 })).toBe('chat:k:7')
    expect(targetKey({ kind: 'report' })).toBe('report')
    expect(popoutName('report', 2)).toBe('iskra-popout-report-2')
    // Each account on the device has names of its own (security review L4), still ones the desktop app takes.
    expect(popoutName('voice', 1, 2)).toBe('iskra-popout-voice-a2x1')
    expect(popoutName('voice', 1, 3)).not.toBe(popoutName('voice', 1, 2))
    expect(popoutName('chat', 123456, 5)).toMatch(/^iskra-popout-chat-[a-z0-9]{1,24}$/)
  })
})

describe('pop-outs close with what they show', () => {
  const open = [
    { id: 'v', target: { kind: 'voice' as const } },
    { id: 's1', target: { kind: 'stream' as const, tileId: 'a:1' } },
    { id: 's2', target: { kind: 'stream' as const, tileId: 'b:2' } },
    { id: 'c', target: { kind: 'chat' as const, serverKey: 'k', channelId: 3 } },
    { id: 'r', target: { kind: 'report' as const } },
  ]
  const channels = (ids: number[]) => (serverKey: string, channelId: number) => serverKey === 'k' && ids.includes(channelId)

  it('all stay while the call, its streams and the channel are there', () => {
    expect(stalePopouts(open, { inVoice: true, tileIds: new Set(['a:1', 'b:2']), channelExists: channels([3]) })).toEqual([])
  })

  it('a stream that stopped closes alone', () => {
    expect(stalePopouts(open, { inVoice: true, tileIds: new Set(['a:1']), channelExists: channels([3]) })).toEqual(['s2'])
  })

  it('leaving the call closes the voice panel and every stream, not the channel', () => {
    expect(stalePopouts(open, { inVoice: false, tileIds: new Set(['a:1', 'b:2']), channelExists: channels([3]) })).toEqual(['v', 's1', 's2'])
  })

  it('the bug report stays whatever happens (it closes with the page)', () => {
    expect(stalePopouts(open, { inVoice: false, tileIds: new Set(), channelExists: channels([]) })).not.toContain('r')
  })

  it('a deleted channel (or a server left) closes its pop-out', () => {
    expect(stalePopouts(open, { inVoice: true, tileIds: new Set(['a:1', 'b:2']), channelExists: channels([]) })).toEqual(['c'])
  })
})
