// Your camera's background in calls: off, blurred or replaced (a built-in picture or a solid colour). Everything
// runs on this device (state/video/); the setting is remembered on this device. If the device can't keep up, or the
// effect can't start here, it turns itself off with a notice and remembers that until you choose it again.
import type { LocalVideoTrack, VideoCaptureOptions } from 'livekit-client'
import { lk } from './livekit'
import { create } from 'zustand'
import { parseBackgroundSettings, type BackgroundSettings, type EffectWindow } from './video/effects'
import { BackgroundProcessor, effectsSupported, type Look } from './video/processor'
import { activeRoom, useVoice } from './voice'

export type EffectNotice = 'slow' | 'failed' | null

interface BackgroundState {
  settings: BackgroundSettings
  /** Turned off by itself on this device (too slow), until chosen again. */
  slow: boolean
  /** Shown in the call when the effect just turned itself off. */
  notice: EffectNotice
  /** The last measurements while it runs in a call (for settings and the log). */
  stats: EffectWindow | null
}

const KEY = 'iskra.background'
const SLOW_KEY = 'iskra.background.slow'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode: this session only */
  }
}

export const useBackground = create<BackgroundState>(() => ({
  settings: parseBackgroundSettings(read(KEY)),
  slow: read(SLOW_KEY) === '1',
  notice: null,
  stats: null,
}))

/** The effect that should run now (null: none). */
export function activeLook(state = useBackground.getState()): Look | null {
  const { settings, slow } = state
  if (settings.mode === 'off' || slow || !effectsSupported()) return null
  return { mode: settings.mode, backdrop: settings.backdrop, color: settings.color }
}

export function updateBackground(patch: Partial<BackgroundSettings>): void {
  const settings = { ...useBackground.getState().settings, ...patch }
  // Choosing an effect again gives it another try.
  const retry = patch.mode !== undefined && patch.mode !== 'off'
  useBackground.setState((s) => ({ settings, slow: retry ? false : s.slow, notice: retry ? null : s.notice }))
  write(KEY, JSON.stringify(settings))
  if (retry) write(SLOW_KEY, null)
  void applyToCall()
}

export function dismissBackgroundNotice(): void {
  useBackground.setState({ notice: null })
}

// ── In the call ──────────────────────────────────────────────────────────

let processor: BackgroundProcessor | null = null
let lastLog = 0

function newProcessor(look: Look): BackgroundProcessor {
  const p: BackgroundProcessor = new BackgroundProcessor(look, {
    onStats: (stats) => {
      if (processor !== p) return
      useBackground.setState({ stats })
      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now()
        console.info(`[iskra] background effect: ${stats.outputFps.toFixed(1)} fps (camera ${stats.inputFps.toFixed(0)}), ${stats.frameMs.toFixed(1)} ms per frame`)
      }
    },
    onSlow: () => {
      if (processor !== p) return
      write(SLOW_KEY, '1')
      useBackground.setState({ slow: true, notice: 'slow', stats: null })
      void applyToCall()
    },
    onFailed: () => {
      if (processor !== p) return
      useBackground.setState({ notice: 'failed', stats: null })
      processor = null
    },
  })
  return p
}

/** Options for turning the camera on in a call: the chosen camera, with the effect already in place (no frame of the room is sent first). */
export function cameraCaptureOptions(): VideoCaptureOptions {
  const { settings } = useBackground.getState()
  const look = activeLook()
  const options: VideoCaptureOptions = settings.camera ? { deviceId: settings.camera } : {}
  // Turning the camera back on reuses the track LiveKit has, and the processor on it.
  if (!look || cameraTrack()) return options
  processor = newProcessor(look)
  return { ...options, processor }
}

function cameraTrack(): LocalVideoTrack | null {
  const room = activeRoom()
  if (!room) return null
  const { Track, LocalVideoTrack } = lk()
  const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track
  return track instanceof LocalVideoTrack ? track : null
}

/** The setting changed (or the effect gave up): bring the camera in the call in line. */
async function applyToCall(): Promise<void> {
  const track = cameraTrack()
  if (!track || !useVoice.getState().camera) return
  const look = activeLook()
  const current = track.getProcessor() as BackgroundProcessor | undefined
  if (!look) {
    processor = null
    useBackground.setState({ stats: null })
    if (current) await track.stopProcessor().catch(() => undefined)
    return
  }
  if (current instanceof BackgroundProcessor && current.running) {
    current.setLook(look)
    return
  }
  processor = newProcessor(look)
  await track.setProcessor(processor).catch((e) => console.warn('[iskra] background effect', e))
}

// The camera came back on: the setting may have changed while it was off.
useVoice.subscribe((s, prev) => {
  if (s.camera && !prev.camera) void applyToCall()
})

/** The chosen camera changed during a call: switch to it. */
export async function switchCamera(deviceId: string): Promise<void> {
  updateBackground({ camera: deviceId })
  const room = activeRoom()
  if (room && useVoice.getState().camera) await room.switchActiveDevice('videoinput', deviceId || 'default').catch(() => undefined)
}
