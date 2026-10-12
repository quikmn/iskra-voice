import { describe, expect, it } from 'vitest'
import { colorFloats, EffectWatch, parseBackgroundSettings, smoothMask, windowTooSlow } from './effects'

describe('background settings', () => {
  it('are off by default and only take known values', () => {
    expect(parseBackgroundSettings(null)).toEqual({ mode: 'off', backdrop: 'aurora', color: '#2f3640', camera: '' })
    expect(parseBackgroundSettings('{"mode":"blur","backdrop":"sunset","color":"#AABBCC","camera":"abc"}'))
      .toEqual({ mode: 'blur', backdrop: 'sunset', color: '#aabbcc', camera: 'abc' })
    expect(parseBackgroundSettings('{"mode":"glitter","backdrop":"x","color":"red","camera":5}'))
      .toEqual({ mode: 'off', backdrop: 'aurora', color: '#2f3640', camera: '' })
    expect(parseBackgroundSettings('{')).toEqual({ mode: 'off', backdrop: 'aurora', color: '#2f3640', camera: '' })
  })

  it('turns colours into floats for the shader', () => {
    expect(colorFloats('#ff8000')).toEqual([1, 128 / 255, 0])
  })
})

describe('falling back when the device is too slow', () => {
  it('judges a window by frame rate and time per frame', () => {
    expect(windowTooSlow({ inputFps: 30, outputFps: 29, frameMs: 8 })).toBe(false)
    expect(windowTooSlow({ inputFps: 30, outputFps: 9, frameMs: 20 })).toBe(true)
    expect(windowTooSlow({ inputFps: 30, outputFps: 25, frameMs: 75 })).toBe(true)
    expect(windowTooSlow({ inputFps: 30, outputFps: 20, frameMs: 40 })).toBe(false)
    // A 15 fps camera at 10 fps processed is fine (60%); a stalled camera says nothing.
    expect(windowTooSlow({ inputFps: 15, outputFps: 10, frameMs: 20 })).toBe(false)
    expect(windowTooSlow({ inputFps: 2, outputFps: 0, frameMs: 0 })).toBe(false)
  })

  it('gives up only after three slow windows in a row, ignoring the warm-up', () => {
    const watch = new EffectWatch()
    const slow = { inputFps: 30, outputFps: 5, frameMs: 80 }
    const fine = { inputFps: 30, outputFps: 30, frameMs: 5 }
    expect(watch.report(slow)).toBe(false) // warm-up
    expect(watch.report(slow)).toBe(false)
    expect(watch.report(slow)).toBe(false)
    expect(watch.report(fine)).toBe(false) // the streak resets
    expect(watch.report(slow)).toBe(false)
    expect(watch.report(slow)).toBe(false)
    expect(watch.report(slow)).toBe(true)
  })
})

describe('mask smoothing', () => {
  it('follows big changes quickly and damps small flicker', () => {
    const mask = new Float32Array([0, 0.5])
    smoothMask(mask, new Float32Array([1, 0.55]))
    expect(mask[0]).toBe(1) // a person moving in: no ghosting
    expect(mask[1]).toBeGreaterThan(0.5)
    expect(mask[1]).toBeLessThan(0.53) // flicker mostly ignored
  })
})
