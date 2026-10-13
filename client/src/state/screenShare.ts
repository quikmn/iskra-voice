// Screen share quality, sound and content hint: remembered on this device, turned into LiveKit options here.
import type { AudioCaptureOptions, ScreenShareCaptureOptions, TrackPublishOptions, VideoEncoding, VideoResolution } from 'livekit-client'
import { create } from 'zustand'

export type ShareQuality = '720p30' | '1080p30' | '1080p60' | 'source'

export interface ScreenShareSettings {
  quality: ShareQuality
  /** Share sound too: a tab's, or the whole computer's where the browser/OS allows. */
  audio: boolean
  /** Motion keeps games and video smooth; detail keeps text and code sharp. */
  hint: 'motion' | 'detail'
}

export const DEFAULT_SHARE: ScreenShareSettings = { quality: 'source', audio: true, hint: 'motion' }

export const QUALITIES: { id: ShareQuality; label: string }[] = [
  { id: '720p30', label: '720p 30' },
  { id: '1080p30', label: '1080p 30' },
  { id: '1080p60', label: '1080p 60' },
  { id: 'source', label: 'Source 60' },
]

/** Capture size and frame rate (0 × 0 = the screen's own size) with the bitrate to send it at. */
// What LiveKit's VideoPreset(width, height, bitrate, fps) gives, without loading LiveKit for it.
const preset = (width: number, height: number, maxBitrate: number, maxFramerate: number): { resolution: VideoResolution; encoding: VideoEncoding } => ({
  resolution: { width, height, frameRate: maxFramerate, aspectRatio: width / height },
  encoding: { maxBitrate, maxFramerate },
})
const PRESETS: Record<ShareQuality, ReturnType<typeof preset>> = {
  '720p30': preset(1280, 720, 2_500_000, 30),
  '1080p30': preset(1920, 1080, 5_000_000, 30),
  '1080p60': preset(1920, 1080, 8_000_000, 60),
  source: preset(0, 0, 12_000_000, 60),
}

/** Saved settings carry this; older ones that still hold the old default (1080p 30) get the new default once. */
const VERSION = 2

export function parseShareSettings(raw: unknown): ScreenShareSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const oldDefault = s.v !== VERSION && s.quality === '1080p30'
  return {
    quality: !oldDefault && QUALITIES.some((q) => q.id === s.quality) ? (s.quality as ShareQuality) : DEFAULT_SHARE.quality,
    audio: typeof s.audio === 'boolean' ? s.audio : DEFAULT_SHARE.audio,
    hint: s.hint === 'detail' || s.hint === 'motion' ? s.hint : DEFAULT_SHARE.hint,
  }
}

/** What to ask the browser for and how to send it. */
export function screenShareOptions(s: ScreenShareSettings): { capture: ScreenShareCaptureOptions; publish: TrackPublishOptions } {
  const preset = PRESETS[s.quality]
  return {
    capture: {
      // restrictOwnAudio: system audio without Iskra's own playback (the call), so nobody hears themselves back.
      audio: s.audio ? ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as AudioCaptureOptions) : false,
      systemAudio: s.audio ? 'include' : 'exclude',
      // Don't play the shared tab's sound twice for you.
      suppressLocalAudioPlayback: s.audio,
      resolution: preset.resolution,
      contentHint: s.hint,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    },
    publish: {
      screenShareEncoding: preset.encoding,
      // Detail: keep the resolution and drop frames when the connection is tight; motion: the opposite.
      degradationPreference: s.hint === 'detail' ? 'maintain-resolution' : 'maintain-framerate',
    },
  }
}

const KEY = 'iskra.screenshare'

export const useScreenShareSettings = create<ScreenShareSettings>(() => {
  try {
    return parseShareSettings(JSON.parse(localStorage.getItem(KEY) ?? '{}'))
  } catch {
    return { ...DEFAULT_SHARE }
  }
})

export function updateShareSettings(patch: Partial<ScreenShareSettings>): void {
  const next = parseShareSettings({ ...useScreenShareSettings.getState(), ...patch, v: VERSION })
  useScreenShareSettings.setState(next, true)
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...next, v: VERSION }))
  } catch {
    /* private mode */
  }
}
