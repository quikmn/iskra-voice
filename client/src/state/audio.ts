// Your sound settings on this device: devices, volumes, noise suppression, the voice activity threshold and how
// incoming voices are processed. The mic itself is processed in micPipeline.ts, incoming audio in listen.ts;
// voice.ts applies these to the call.
import { create } from 'zustand'
import type { NoiseEngine } from './audio/engines'

export type NoiseMode = 'off' | 'standard' | 'strong' | 'ai'

export interface AudioSettings {
  /** 'ai' runs DeepFilterNet3 on the mic, 'strong' RNNoise; 'standard' is the browser's own; 'off' none. */
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
  /** Run noise suppression on what you hear too ("Clean up others' audio"). */
  cleanIncoming: boolean
  /** Even out how loud each incoming voice is. */
  leveling: boolean
  /** Send stereo, 128 kbps, unprocessed sound in voice channels that allow hi-fi. */
  hifi: boolean
}

export const DEFAULT_AUDIO: AudioSettings = {
  noise: 'ai',
  echoCancellation: true,
  autoGainControl: true,
  inputDevice: '',
  outputDevice: '',
  inputVolume: 1,
  outputVolume: 1,
  threshold: null,
  voiceSounds: true,
  cleanIncoming: false,
  leveling: true,
  hifi: false,
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
    noise: s.noise === 'off' || s.noise === 'standard' || s.noise === 'strong' || s.noise === 'ai' ? s.noise : d.noise,
    echoCancellation: typeof s.echoCancellation === 'boolean' ? s.echoCancellation : d.echoCancellation,
    autoGainControl: typeof s.autoGainControl === 'boolean' ? s.autoGainControl : d.autoGainControl,
    inputDevice: typeof s.inputDevice === 'string' ? s.inputDevice.slice(0, 200) : d.inputDevice,
    outputDevice: typeof s.outputDevice === 'string' ? s.outputDevice.slice(0, 200) : d.outputDevice,
    inputVolume: clamp(s.inputVolume, 0, 2, d.inputVolume),
    outputVolume: clamp(s.outputVolume, 0, 2, d.outputVolume),
    threshold: s.threshold === null || s.threshold === undefined ? null : clamp(s.threshold, MIN_THRESHOLD, 0, -50),
    voiceSounds: typeof s.voiceSounds === 'boolean' ? s.voiceSounds : d.voiceSounds,
    cleanIncoming: typeof s.cleanIncoming === 'boolean' ? s.cleanIncoming : d.cleanIncoming,
    leveling: typeof s.leveling === 'boolean' ? s.leveling : d.leveling,
    hifi: typeof s.hifi === 'boolean' ? s.hifi : d.hifi,
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

/** Choosing where sound plays (Chrome, Edge, Firefox, the desktop app; not Safari). */
export const outputSelectable = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/** Boosting people above 100% needs LiveKit's Web Audio mixing, which also needs AudioContext.setSinkId. */
export const canBoost = () => typeof AudioContext === 'function' && 'setSinkId' in AudioContext.prototype

/**
 * Getting the mic: the browser's processing that's on, given the engine that runs on top of it. Ours do a better
 * job and doing both just muffles you, so the browser's only runs when it's the engine. Hi-fi turns all of it off
 * and captures stereo.
 */
export function captureOptions(s: AudioSettings, engine: NoiseEngine, hifi = false) {
  return {
    deviceId: s.inputDevice ? { exact: s.inputDevice } : undefined,
    echoCancellation: hifi ? false : s.echoCancellation,
    noiseSuppression: hifi ? false : engine === 'browser',
    autoGainControl: hifi ? false : s.autoGainControl,
    channelCount: hifi ? 2 : 1,
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
