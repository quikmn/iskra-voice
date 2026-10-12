import { describe, expect, it } from 'vitest'
import { DEFAULT_SHARE, parseShareSettings, screenShareOptions, updateShareSettings, useScreenShareSettings } from './screenShare'

describe('screen share options', () => {
  it('defaults to Source at 60 fps with sound, optimised for motion', () => {
    expect(DEFAULT_SHARE.quality).toBe('source')
    expect(screenShareOptions(DEFAULT_SHARE).capture.resolution).toMatchObject({ width: 0, height: 0, frameRate: 60 })
    expect(screenShareOptions(DEFAULT_SHARE).publish.screenShareEncoding).toMatchObject({ maxFramerate: 60 })
    expect(parseShareSettings(null)).toEqual(DEFAULT_SHARE)
    expect(parseShareSettings({ quality: '4k', audio: 'yes', hint: 'text' })).toEqual(DEFAULT_SHARE)
  })

  it('moves a saved old default (1080p 30) to the new default once, but keeps a choice made since', () => {
    expect(parseShareSettings({ quality: '1080p30', audio: false, hint: 'detail' })).toEqual({ quality: 'source', audio: false, hint: 'detail' })
    expect(parseShareSettings({ quality: '1080p30', audio: true, hint: 'motion', v: 2 }).quality).toBe('1080p30')
    expect(parseShareSettings({ quality: '720p30' }).quality).toBe('720p30')
  })

  it('remembers a deliberate 1080p 30 pick', () => {
    updateShareSettings({ quality: '1080p30' })
    expect(useScreenShareSettings.getState().quality).toBe('1080p30')
  })

  it('turns each quality into a capture size, frame rate and bitrate', () => {
    const at = (quality: typeof DEFAULT_SHARE.quality) => screenShareOptions({ ...DEFAULT_SHARE, quality })
    expect(at('720p30').capture.resolution).toMatchObject({ width: 1280, height: 720, frameRate: 30 })
    expect(at('1080p60').capture.resolution).toMatchObject({ width: 1920, height: 1080, frameRate: 60 })
    expect(at('1080p60').publish.screenShareEncoding).toMatchObject({ maxFramerate: 60 })
    // Source: no resize (0 × 0 means uncapped to LiveKit).
    expect(at('source').capture.resolution).toMatchObject({ width: 0, height: 0 })
    expect(at('1080p30').publish.screenShareEncoding!.maxBitrate).toBeLessThan(at('1080p60').publish.screenShareEncoding!.maxBitrate)
  })

  it('asks for sound only when wanted, unprocessed', () => {
    expect(screenShareOptions({ ...DEFAULT_SHARE, audio: false }).capture).toMatchObject({ audio: false, systemAudio: 'exclude' })
    expect(screenShareOptions(DEFAULT_SHARE).capture).toMatchObject({ audio: { noiseSuppression: false, echoCancellation: false, restrictOwnAudio: true }, systemAudio: 'include' })
  })

  it('motion keeps the frame rate, detail keeps the resolution', () => {
    expect(screenShareOptions(DEFAULT_SHARE).capture.contentHint).toBe('motion')
    expect(screenShareOptions(DEFAULT_SHARE).publish.degradationPreference).toBe('maintain-framerate')
    const detail = screenShareOptions({ ...DEFAULT_SHARE, hint: 'detail' })
    expect(detail.capture.contentHint).toBe('detail')
    expect(detail.publish.degradationPreference).toBe('maintain-resolution')
  })
})
