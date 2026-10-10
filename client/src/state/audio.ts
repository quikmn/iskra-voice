// Your sound settings on this device: devices, volumes, noise suppression and the voice activity threshold.
// The mic itself is processed in micPipeline.ts; voice.ts applies these to the call.
import { create } from 'zustand'

export type NoiseMode = 'off' | 'standard' | 'strong'

export interface AudioSettings {
  /** 'strong' runs RNNoise on the mic; 'standard' is the browser's own; 'off' neither. */
  noise: NoiseMode
  echoCancellation: boolean
  autoGainControl: boolean
  /** '' = the system default. */
  inputDevice: string
  outputDevice: string
  /** 0–2, applied to your mic before it's sent. */
  inputVolume: number
  /** 0–1 (0–2 where the app can boost), multiplied with each person's own volume. */
  outputVolume: number
  /** Voice activity: open the mic by itself (null) or only above this level in dBFS. */
  threshold: number | null
  /** Join, leave, mute and deafen sounds. */
  voiceSounds: boolean
}

export const DEFAULT_AUDIO: AudioSettings = {
  noise: 'strong',
  echoCancellation: true,
  autoGainControl: true,
  inputDevice: '',
  outputDevice: '',
  inputVolume: 1,
  outputVolume: 1,
  threshold: null,
  voiceSounds: true,
}

export const MIN_THRESHOLD = -80
/** In automatic mode, anything louder than this (after noise suppression) counts as speaking. */
export const AUTO_SPEAKING_DB = -50

const KEY = 'iskra.audio'

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback

/** Reads stored settings, dropping anything malformed. */
export function parseAudioSettings(raw: unknown): AudioSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_AUDIO
  return {
    noise: s.noise === 'off' || s.noise === 'standard' || s.noise === 'strong' ? s.noise : d.noise,
    echoCancellation: typeof s.echoCancellation === 'boolean' ? s.echoCancellation : d.echoCancellation,
    autoGainControl: typeof s.autoGainControl === 'boolean' ? s.autoGainControl : d.autoGainControl,
    inputDevice: typeof s.inputDevice === 'string' ? s.inputDevice.slice(0, 200) : d.inputDevice,
    outputDevice: typeof s.outputDevice === 'string' ? s.outputDevice.slice(0, 200) : d.outputDevice,
    inputVolume: clamp(s.inputVolume, 0, 2, d.inputVolume),
    outputVolume: clamp(s.outputVolume, 0, 2, d.outputVolume),
    threshold: s.threshold === null || s.threshold === undefined ? null : clamp(s.threshold, MIN_THRESHOLD, 0, -50),
    voiceSounds: typeof s.voiceSounds === 'boolean' ? s.voiceSounds : d.voiceSounds,
  }
}

function load(): AudioSettings {
  try {
    return parseAudioSettings(JSON.parse(localStorage.getItem(KEY) ?? '{}'))
  } catch {
    return { ...DEFAULT_AUDIO }
  }
}

export const useAudio = create<AudioSettings>(load)

type Listener = (next: AudioSettings, prev: AudioSettings) => void
const listeners = new Set<Listener>()
/** voice.ts listens to apply changes to a running call. */
export function onAudioSettings(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function updateAudio(patch: Partial<AudioSettings>): void {
  const prev = useAudio.getState()
  const next = parseAudioSettings({ ...prev, ...patch })
  useAudio.setState(next, true)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode: this session only */
  }
  for (const listener of listeners) listener(next, prev)
}

// ── What this browser can do ─────────────────────────────────────────────

/** RNNoise needs AudioWorklet, WebAssembly and a way to turn the result back into a track. */
export function strongSupported(): boolean {
  return typeof AudioWorkletNode === 'function' && typeof WebAssembly === 'object' && typeof AudioContext === 'function' &&
    'createMediaStreamDestination' in AudioContext.prototype
}

/** Choosing where sound plays (Chrome, Edge, Firefox, the desktop app; not Safari). */
export const outputSelectable = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/** Boosting people above 100% needs LiveKit's Web Audio mixing, which also needs AudioContext.setSinkId. */
export const canBoost = () => typeof AudioContext === 'function' && 'setSinkId' in AudioContext.prototype

/** Getting the mic: the browser's processing that's on, given what runs on top of it. */
export function captureOptions(s: AudioSettings, strongActive: boolean) {
  return {
    deviceId: s.inputDevice ? { exact: s.inputDevice } : undefined,
    echoCancellation: s.echoCancellation,
    // RNNoise does a better job; doing both just muffles you. If RNNoise can't run, fall back to the browser's.
    noiseSuppression: s.noise === 'standard' || (s.noise === 'strong' && !strongActive),
    autoGainControl: s.autoGainControl,
    channelCount: 1,
  }
}

/** One person's playback volume: theirs times yours, kept to what this device can play. */
export function effectiveVolume(personal: number, output: number, deafened: boolean, boost: boolean): number {
  if (deafened) return 0
  const v = personal * output
  return Math.min(boost ? 2 : 1, Math.max(0, Number.isFinite(v) ? v : 1))
}

/** 0–1 for a level meter (MIN_THRESHOLD dB to 0 dB). */
export const meterFraction = (db: number) => Math.min(1, Math.max(0, (db - MIN_THRESHOLD) / -MIN_THRESHOLD))
