// Screen share quality, sound and content hint: remembered on this device, turned into LiveKit options here.
import { VideoPreset, type ScreenShareCaptureOptions, type TrackPublishOptions } from 'livekit-client'
import { create } from 'zustand'

export type ShareQuality = '720p30' | '1080p30' | '1080p60' | 'source'

export interface ScreenShareSettings {
  quality: ShareQuality
  /** Share sound too: a tab's, or the whole computer's where the browser/OS allows. */
  audio: boolean
  /** Motion keeps games and video smooth; detail keeps text and code sharp. */
  hint: 'motion' | 'detail'
}

export const DEFAULT_SHARE: ScreenShareSettings = { quality: '1080p30', audio: true, hint: 'motion' }

export const QUALITIES: { id: ShareQuality; label: string }[] = [
  { id: '720p30', label: '720p 30' },
  { id: '1080p30', label: '1080p 30' },
  { id: '1080p60', label: '1080p 60' },
  { id: 'source', label: 'Source' },
]

/** Capture size and frame rate (0 × 0 = the screen's own size) with the bitrate to send it at. */
const PRESETS: Record<ShareQuality, VideoPreset> = {
  '720p30': new VideoPreset(1280, 720, 2_500_000, 30),
  '1080p30': new VideoPreset(1920, 1080, 5_000_000, 30),
  '1080p60': new VideoPreset(1920, 1080, 8_000_000, 60),
  source: new VideoPreset(0, 0, 10_000_000, 30),
}

export function parseShareSettings(raw: unknown): ScreenShareSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    quality: QUALITIES.some((q) => q.id === s.quality) ? (s.quality as ShareQuality) : DEFAULT_SHARE.quality,
    audio: typeof s.audio === 'boolean' ? s.audio : DEFAULT_SHARE.audio,
    hint: s.hint === 'detail' || s.hint === 'motion' ? s.hint : DEFAULT_SHARE.hint,
  }
}

/** What to ask the browser for and how to send it. */
export function screenShareOptions(s: ScreenShareSettings): { capture: ScreenShareCaptureOptions; publish: TrackPublishOptions } {
  const preset = PRESETS[s.quality]
  return {
    capture: {
      audio: s.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
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
  const next = parseShareSettings({ ...useScreenShareSettings.getState(), ...patch })
  useScreenShareSettings.setState(next, true)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
}
