import { describe, expect, it } from 'vitest'
import { captureOptions, DEFAULT_AUDIO, effectiveVolume, meterFraction, parseAudioSettings } from './audio'
import { Gate, HOLD_MS } from './micGate'

describe('audio settings', () => {
  it('defaults to AI noise removal and leveling, and keeps only valid stored values', () => {
    expect(parseAudioSettings(undefined)).toEqual(DEFAULT_AUDIO)
    expect(DEFAULT_AUDIO).toMatchObject({ noise: 'ai', leveling: true, cleanIncoming: false, hifi: false })
    const parsed = parseAudioSettings({
      noise: 'loud', echoCancellation: 'yes', inputVolume: 9, outputVolume: -1, threshold: -500, inputDevice: 42, voiceSounds: false,
      leveling: 'no', cleanIncoming: true, hifi: 1,
    })
    expect(parsed).toMatchObject({
      noise: 'ai', echoCancellation: true, inputVolume: 2, outputVolume: 0, threshold: -80, inputDevice: '', voiceSounds: false,
      leveling: true, cleanIncoming: true, hifi: false,
    })
    expect(parseAudioSettings({ noise: 'strong' }).noise).toBe('strong') // RNNoise stays a choice
    expect(parseAudioSettings({ threshold: null }).threshold).toBeNull()
    expect(parseAudioSettings({ inputVolume: Number.NaN }).inputVolume).toBe(1)
  })

  it("only runs the browser's noise suppression when it's the engine", () => {
    const strong = { ...DEFAULT_AUDIO, noise: 'strong' as const }
    expect(captureOptions(strong, 'rnnoise').noiseSuppression).toBe(false)
    expect(captureOptions(strong, 'ai').noiseSuppression).toBe(false)
    expect(captureOptions(strong, 'browser').noiseSuppression).toBe(true)
    expect(captureOptions({ ...strong, noise: 'off' }, 'off').noiseSuppression).toBe(false)
    expect(captureOptions({ ...strong, echoCancellation: false, autoGainControl: false }, 'rnnoise')).toMatchObject({ echoCancellation: false, autoGainControl: false })
    expect(captureOptions(strong, 'rnnoise').deviceId).toBeUndefined()
    expect(captureOptions({ ...strong, inputDevice: 'abc' }, 'rnnoise').deviceId).toEqual({ exact: 'abc' })
  })

  it('captures hi-fi in stereo with none of the processing', () => {
    expect(captureOptions(DEFAULT_AUDIO, 'browser', true)).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 })
    expect(captureOptions(DEFAULT_AUDIO, 'ai').channelCount).toBe(1)
  })

  it('mixes personal and output volume within what the device can play', () => {
    expect(effectiveVolume(1.5, 1, false, true)).toBe(1.5)
    expect(effectiveVolume(1.5, 1, false, false)).toBe(1)
    expect(effectiveVolume(2, 2, false, true)).toBe(2)
    expect(effectiveVolume(0.5, 0.5, false, false)).toBe(0.25)
    expect(effectiveVolume(1, 1, true, true)).toBe(0)
  })

  it('maps levels onto the meter', () => {
    expect(meterFraction(0)).toBe(1)
    expect(meterFraction(-80)).toBe(0)
    expect(meterFraction(-160)).toBe(0)
    expect(meterFraction(-40)).toBeCloseTo(0.5)
  })
})

describe('voice activity gate', () => {
  const block = (amplitude: number) => new Float32Array(128).fill(amplitude)
  const run = (gate: Gate, amplitude: number, blocks: number) => {
    const out = new Float32Array(128)
    for (let i = 0; i < blocks; i++) gate.process(block(amplitude), out)
    return out
  }

  it('opens above the threshold and closes after the hold time', () => {
    const gate = new Gate(48000)
    gate.params = { gain: 1, threshold: -40, gating: true }
    run(gate, 0.001, 5) // -60 dB
    expect(gate.open).toBe(false)
    const loud = run(gate, 0.1, 20) // -20 dB
    expect(gate.open).toBe(true)
    expect(loud[127]).toBeCloseTo(0.1, 3)
    const blockMs = (128 / 48000) * 1000
    run(gate, 0.001, Math.floor(HOLD_MS / blockMs) - 2)
    expect(gate.open).toBe(true) // still holding: the end of a word isn't cut off
    const quiet = run(gate, 0.001, 200)
    expect(gate.open).toBe(false)
    expect(quiet[127]).toBe(0)
  })

  it('only reports in automatic mode, and applies input volume first', () => {
    const gate = new Gate(48000)
    gate.params = { gain: 2, threshold: -50, gating: false }
    const out = run(gate, 0.001, 3)
    expect(out[0]).toBeCloseTo(0.002) // passed through, doubled
    expect(gate.open).toBe(false)
    expect(gate.takePeak()).toBeCloseTo(20 * Math.log10(0.002), 1)
    expect(gate.takePeak()).toBe(-160) // starts over after each report
  })

  it('fades instead of clicking', () => {
    const gate = new Gate(48000)
    gate.params = { gain: 1, threshold: -40, gating: true }
    const first = new Float32Array(128)
    gate.process(block(0.5), first)
    expect(first[0]).toBe(0)
    expect(first[127]).toBeGreaterThan(0)
    expect(first[127]).toBeLessThan(0.5)
  })
})
