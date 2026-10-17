// The built-in notification sounds, synthesized with WebAudio when they play: nothing to download or bundle.
import { useAudio } from '../audio'
import type { BuiltinSound } from './soundLogic'

/** One partial: a frequency (optionally gliding to `to`), when it starts, how long it rings, how loud. */
interface Partial {
  f: number
  to?: number
  at: number
  ring: number
  gain: number
  wave?: OscillatorType
}

const SOUNDS: Record<BuiltinSound, Partial[]> = {
  // The two-note blip Iskra always had.
  classic: [
    { f: 880, at: 0, ring: 0.16, gain: 0.12 },
    { f: 1320, at: 0.09, ring: 0.16, gain: 0.12 },
  ],
  // A soft fifth, ringing out.
  chime: [
    { f: 1046.5, at: 0, ring: 0.6, gain: 0.08, wave: 'triangle' },
    { f: 1568, at: 0.07, ring: 0.7, gain: 0.07, wave: 'triangle' },
  ],
  // A quick bubble.
  pop: [{ f: 520, to: 1250, at: 0, ring: 0.09, gain: 0.16 }],
  // A small bell: a fundamental with inharmonic overtones.
  bell: [
    { f: 1318.5, at: 0, ring: 1.0, gain: 0.08 },
    { f: 1318.5 * 2.76, at: 0, ring: 0.45, gain: 0.025 },
    { f: 1318.5 * 5.4, at: 0, ring: 0.2, gain: 0.012 },
  ],
  // A water drop: a falling glide.
  droplet: [{ f: 1500, to: 480, at: 0, ring: 0.16, gain: 0.14 }],
  // Two wooden notes.
  marimba: [
    { f: 784, at: 0, ring: 0.28, gain: 0.12 },
    { f: 784 * 4, at: 0, ring: 0.05, gain: 0.03 },
    { f: 987.8, at: 0.12, ring: 0.3, gain: 0.12 },
    { f: 987.8 * 4, at: 0.12, ring: 0.05, gain: 0.03 },
  ],
}

let context: AudioContext | null = null
let sink = ''

/** The shared context for little sounds, on the chosen output device where the browser allows it. Null if audio isn't allowed. */
export function soundContext(): AudioContext | null {
  try {
    context ??= new AudioContext()
    const chosen = useAudio.getState().outputDevice
    const ctx = context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (chosen !== sink && ctx.setSinkId) {
      sink = chosen
      void ctx.setSinkId(chosen).catch(() => undefined)
    }
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    return context
  } catch {
    return null // no user gesture yet, or no audio at all
  }
}

/** Plays partials (also the voice tones in notify.ts). */
export function playPartials(partials: Partial[]): void {
  const ctx = soundContext()
  if (!ctx) return
  for (const p of partials) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const start = ctx.currentTime + p.at
    osc.type = p.wave ?? 'sine'
    osc.frequency.setValueAtTime(p.f, start)
    if (p.to) osc.frequency.exponentialRampToValueAtTime(p.to, start + p.ring * 0.8)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(p.gain, start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + p.ring)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start)
    osc.stop(start + p.ring + 0.02)
  }
}

export const playBuiltin = (id: BuiltinSound) => playPartials(SOUNDS[id])

/** Two-or-three-note tones at even steps (join, leave, mute, ...). */
export const tone = (notes: number[]): Partial[] => notes.map((f, i) => ({ f, at: i * 0.09, ring: 0.16, gain: 0.12 }))

/** Your own sound's samples. */
export function playSamples(samples: Float32Array, rate: number): void {
  const ctx = soundContext()
  if (!ctx || samples.length === 0) return
  const buffer = ctx.createBuffer(1, samples.length, rate)
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start()
}
