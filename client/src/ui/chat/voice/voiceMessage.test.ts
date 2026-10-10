import { describe, expect, it } from 'vitest'
import {
  CANCEL_SLIDE_PX, decodeWaveform, encodeWaveform, extensionFor, formatDuration, nextRate, pickRecordingType, releaseAction, waveformBars,
} from './voiceMessage'

describe('recording format', () => {
  it('prefers Ogg, then WebM, then MP4 (Safari)', () => {
    expect(pickRecordingType(() => true)).toBe('audio/ogg;codecs=opus')
    expect(pickRecordingType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus')
    expect(pickRecordingType((t) => t === 'audio/mp4')).toBe('audio/mp4')
    expect(pickRecordingType(() => false)).toBe('')
    expect(pickRecordingType(() => { throw new Error('old browser') })).toBe('')
  })

  it('names files after what was recorded', () => {
    expect(extensionFor('audio/ogg; codecs=opus')).toBe('ogg')
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm')
    expect(extensionFor('audio/mp4')).toBe('m4a')
    expect(extensionFor('audio/x-m4a')).toBe('m4a')
    expect(extensionFor('')).toBe('webm')
  })
})

describe('waveform', () => {
  it('averages levels into bars scaled to the loudest', () => {
    const bars = waveformBars([0, 0, 0.5, 0.5, 0.1, 0.1, 0, 0], 4)
    expect(Array.from(bars)).toEqual([0, 255, Math.round(Math.sqrt(0.2) * 255), 0])
  })

  it('stretches short recordings and keeps silence flat', () => {
    expect(waveformBars([0.3], 8).every((b) => b === 255)).toBe(true)
    expect(Array.from(waveformBars([0, 0.001, 0], 4))).toEqual([0, 0, 0, 0])
    expect(waveformBars([], 64)).toHaveLength(64)
  })

  it('round-trips through base64url and resamples for display', () => {
    const bytes = Uint8Array.from([0, 255, 128, 64])
    const text = encodeWaveform(bytes)
    expect(text).not.toMatch(/[+/=]/)
    expect(decodeWaveform(text, 4)).toEqual([0, 1, 128 / 255, 64 / 255])
    expect(decodeWaveform(text, 8)).toHaveLength(8)
    expect(decodeWaveform('!!!', 3)).toEqual([0, 0, 0])
  })
})

describe('player and recorder bits', () => {
  it('formats durations', () => {
    expect(formatDuration(7_200)).toBe('0:07')
    expect(formatDuration(83_000)).toBe('1:23')
    expect(formatDuration(300_000)).toBe('5:00')
  })

  it('cycles playback speed 1×, 1.5×, 2×', () => {
    expect(nextRate(1)).toBe(1.5)
    expect(nextRate(1.5)).toBe(2)
    expect(nextRate(2)).toBe(1)
  })

  it('tap locks, hold sends, slide cancels', () => {
    expect(releaseAction(120, 0)).toBe('lock')
    expect(releaseAction(2_000, 10)).toBe('send')
    expect(releaseAction(2_000, CANCEL_SLIDE_PX + 1)).toBe('cancel')
  })
})
