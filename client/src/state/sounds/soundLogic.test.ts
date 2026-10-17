import { describe, expect, it } from 'vitest'
import {
  checkDecoded, checkUploadFile, decodePcm, emptySoundPrefs, encodePcm, MAX_CHANNEL_OVERRIDES, MAX_UPLOAD_BYTES, overrideAt,
  parseCustomSound, parseSoundPrefs, peakOf, playable, resolveSound, tame, withDefault, withOverride, type SoundPrefs,
} from './soundLogic'

const prefs = (patch: Partial<SoundPrefs> = {}): SoundPrefs => ({ ...emptySoundPrefs(), updatedAt: 1, ...patch })

describe('which sound plays', () => {
  const p = prefs({
    message: 'pop', mention: 'bell', dm: 'chime',
    servers: { srv: 'marimba', other: 'none' },
    channels: { 'srv:7': 'droplet' },
  })

  it('a channel choice wins over the server and you', () => {
    expect(resolveSound(p, 'message', { serverKey: 'srv', channelId: 7 })).toBe('droplet')
    expect(resolveSound(p, 'mention', { serverKey: 'srv', channelId: 7 })).toBe('droplet')
  })

  it('then the server, then yours for that kind', () => {
    expect(resolveSound(p, 'message', { serverKey: 'srv', channelId: 8 })).toBe('marimba')
    expect(resolveSound(p, 'mention', { serverKey: 'srv' })).toBe('marimba')
    expect(resolveSound(p, 'message', { serverKey: 'other', channelId: 1 })).toBe('none')
    expect(resolveSound(p, 'message', { serverKey: 'third', channelId: 7 })).toBe('pop')
    expect(resolveSound(p, 'mention', { serverKey: 'third' })).toBe('bell')
  })

  it('DMs only follow your choice', () => {
    expect(resolveSound(p, 'dm', { serverKey: 'srv', channelId: 7 })).toBe('chime')
    expect(resolveSound(p, 'dm')).toBe('chime')
  })

  it('your own sound falls back to Classic where this device has none', () => {
    expect(playable('custom', false)).toBe('classic')
    expect(playable('custom', true)).toBe('custom')
    expect(playable('bell', false)).toBe('bell')
  })
})

describe('changing choices', () => {
  it('sets and removes overrides, newer than before', () => {
    const start = prefs({ updatedAt: 500 })
    const a = withOverride(start, { serverKey: 'srv', channelId: 3 }, 'bell', 100)
    expect(a.channels).toEqual({ 'srv:3': 'bell' })
    expect(a.updatedAt).toBe(501) // never older than what it replaces
    expect(overrideAt(a, 'srv', 3)).toBe('bell')
    expect(overrideAt(a, 'srv', null)).toBeNull()
    const b = withOverride(a, { serverKey: 'srv' }, 'pop', 1000)
    expect(b.servers).toEqual({ srv: 'pop' })
    expect(withOverride(b, { serverKey: 'srv', channelId: 3 }, null, 2000).channels).toEqual({})
    expect(withDefault(b, 'dm', 'none', 3000)).toMatchObject({ dm: 'none', updatedAt: 3000 })
  })

  it('keeps the newest overrides when there are too many', () => {
    let p = prefs()
    for (let i = 0; i <= MAX_CHANNEL_OVERRIDES; i++) p = withOverride(p, { serverKey: 'srv', channelId: i }, 'pop', i + 10)
    expect(Object.keys(p.channels)).toHaveLength(MAX_CHANNEL_OVERRIDES)
    expect(p.channels['srv:0']).toBeUndefined()
    expect(p.channels[`srv:${MAX_CHANNEL_OVERRIDES}`]).toBe('pop')
  })

  it('fits the synced setting even when full', () => {
    let p = prefs()
    const key = 'A'.repeat(43)
    for (let i = 0; i < 200; i++) {
      p = withOverride(p, { serverKey: `${key.slice(0, 40)}${i}`, channelId: 10_000_000 + i }, 'marimba', i + 10)
      p = withOverride(p, { serverKey: `${key.slice(0, 40)}${i}` }, 'droplet', i + 10)
    }
    // 16 KB of ciphertext, less the nonce and tag.
    expect(JSON.stringify(p).length).toBeLessThan(16 * 1024 - 64)
  })
})

describe('reading synced copies', () => {
  it('takes good copies and drops what it does not know', () => {
    const parsed = parseSoundPrefs({
      message: 'bell', mention: 'nope', dm: 'custom', updatedAt: 9,
      servers: { good: 'pop', 'bad key!': 'pop', other: 'loud' },
      channels: { 'good:4': 'chime', 'good:x': 'chime' },
    })
    expect(parsed).toEqual({ message: 'bell', mention: 'classic', dm: 'custom', servers: { good: 'pop' }, channels: { 'good:4': 'chime' }, updatedAt: 9 })
    expect(parseSoundPrefs({ message: 'bell' })).toBeNull()
    expect(parseSoundPrefs(null)).toBeNull()
    expect(parseSoundPrefs({ updatedAt: -1 })).toBeNull()
  })
})

describe('your own sound', () => {
  it('must be an audio file of up to 1 MB', () => {
    expect(checkUploadFile({ name: 'ding.mp3', size: 20_000, type: 'audio/mpeg' })).toBeNull()
    expect(checkUploadFile({ name: 'ding.ogg', size: 20_000, type: '' })).toBeNull() // no type: by its name
    expect(checkUploadFile({ name: 'ding.webm', size: 20_000, type: 'video/webm' })).toBeNull()
    expect(checkUploadFile({ name: 'cat.png', size: 20_000, type: 'image/png' })).toBe('notAudio')
    expect(checkUploadFile({ name: 'setup.exe', size: 20_000, type: '' })).toBe('notAudio')
    expect(checkUploadFile({ name: 'ding.wav', size: MAX_UPLOAD_BYTES + 1, type: 'audio/wav' })).toBe('tooBig')
    expect(checkUploadFile({ name: 'ding.wav', size: 0, type: 'audio/wav' })).toBe('empty')
  })

  it('must be short and not silent once decoded', () => {
    expect(checkDecoded({ duration: 1.2, length: 26_460, peak: 0.4 })).toBeNull()
    expect(checkDecoded({ duration: 4, length: 88_200, peak: 0.4 })).toBeNull()
    expect(checkDecoded({ duration: 4.5, length: 99_225, peak: 0.4 })).toBe('tooLong')
    expect(checkDecoded({ duration: 1, length: 22_050, peak: 0 })).toBe('empty')
    expect(checkDecoded({ duration: 0.005, length: 100, peak: 0.5 })).toBe('empty')
    expect(checkDecoded({ duration: Number.NaN, length: 0, peak: 0 })).toBe('unreadable')
  })

  it('loud sounds come down, quiet ones stay', () => {
    const loud = tame(new Float32Array([0.1, -1, 0.5]))
    expect(peakOf(loud)).toBeCloseTo(0.5)
    const quiet = new Float32Array([0.1, -0.2])
    expect(tame(quiet)).toBe(quiet)
  })

  it('is kept as 16-bit PCM and read back', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const back = decodePcm(encodePcm(samples))!
    expect(back).toHaveLength(5)
    back.forEach((s, i) => expect(s).toBeCloseTo(samples[i], 3))
    expect(decodePcm('not base64!')).toBeNull()
    expect(decodePcm(btoa('abc'))).toBeNull() // odd length: not 16-bit samples
  })

  it('a kept sound must still be valid when read', () => {
    const pcm = encodePcm(new Float32Array(100).fill(0.2))
    expect(parseCustomSound({ name: 'ding.mp3', seconds: 1.2, pcm })).toEqual({ name: 'ding.mp3', seconds: 1.2, pcm })
    expect(parseCustomSound({ name: 'ding.mp3', seconds: 9, pcm })).toBeNull()
    expect(parseCustomSound({ name: 'ding.mp3', seconds: 1, pcm: '%%' })).toBeNull()
    expect(parseCustomSound('nope')).toBeNull()
  })
})
