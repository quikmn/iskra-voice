// Voice message helpers with no DOM: recording format choice, waveform bars, durations.

export const MAX_VOICE_MS = 5 * 60 * 1000
/** Bars stored with the message (the server allows up to 128). */
export const WAVEFORM_BARS = 64

/**
 * Recording formats in order of preference. Ogg Opus (Firefox) lets the server check the length; WebM Opus is
 * Chrome's; Safari and iOS only record MP4/AAC. Formats the server won't take as voice (raw AAC) are left out.
 */
const PREFERRED = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']

/** The format to ask MediaRecorder for, or '' to let the browser choose. */
export function pickRecordingType(isSupported: (type: string) => boolean): string {
  return PREFERRED.find((type) => {
    try {
      return isSupported(type)
    } catch {
      return false
    }
  }) ?? ''
}

/** A file name extension for what MediaRecorder actually produced. */
export function extensionFor(mimeType: string): string {
  const type = mimeType.toLowerCase()
  if (type.startsWith('audio/ogg')) return 'ogg'
  if (type.startsWith('audio/webm') || type.startsWith('video/webm')) return 'webm'
  if (type.includes('mp4') || type.includes('aac') || type.includes('m4a')) return 'm4a'
  return 'webm'
}

/**
 * Turns loudness samples (RMS, 0–1, taken while recording) into `bars` bytes: averaged per bar, then scaled so the
 * loudest bar is 255 (quiet recordings still show a shape; silence stays flat).
 */
export function waveformBars(levels: number[], bars = WAVEFORM_BARS): Uint8Array {
  const out = new Uint8Array(bars)
  if (levels.length === 0) return out
  const averaged: number[] = []
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * levels.length) / bars)
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / bars))
    let sum = 0
    for (let j = start; j < end && j < levels.length; j++) sum += Math.max(0, levels[j])
    averaged.push(sum / (end - start))
  }
  const peak = Math.max(...averaged)
  if (peak < 0.002) return out
  averaged.forEach((v, i) => (out[i] = Math.round(Math.sqrt(v / peak) * 255)))
  return out
}

export function encodeWaveform(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The stored waveform as `count` heights between 0 and 1 (resampled; junk gives a flat line). */
export function decodeWaveform(waveform: string, count: number): number[] {
  let bytes: number[] = []
  try {
    const binary = atob(waveform.replace(/-/g, '+').replace(/_/g, '/'))
    bytes = Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    /* not base64 */
  }
  if (bytes.length === 0) return Array(count).fill(0)
  return Array.from({ length: count }, (_, i) => bytes[Math.min(bytes.length - 1, Math.floor((i * bytes.length) / count))] / 255)
}

/** 0:07, 1:23, 5:00. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export const PLAYBACK_RATES = [1, 1.5, 2] as const
export const nextRate = (rate: number) => PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate as 1) + 1) % PLAYBACK_RATES.length]

/** How a press on the mic button ended: a short tap locks recording on, a hold sends on release, sliding away cancels. */
export function releaseAction(heldMs: number, slidPx: number): 'lock' | 'send' | 'cancel' {
  if (slidPx >= CANCEL_SLIDE_PX) return 'cancel'
  return heldMs < TAP_MS ? 'lock' : 'send'
}
export const TAP_MS = 350
export const CANCEL_SLIDE_PX = 90
