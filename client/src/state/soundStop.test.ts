import { afterEach, describe, expect, it, vi } from 'vitest'
import { playUrl, stopSounds, useSoundsPlaying } from './expressions'

class FakeAudio {
  static made: FakeAudio[] = []
  volume = 1
  paused = false
  src: string | null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.src = url
    FakeAudio.made.push(this)
  }
  play() {
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  removeAttribute() {
    this.src = null
  }
}

describe('soundboard playback', () => {
  afterEach(() => {
    stopSounds()
    FakeAudio.made = []
    vi.unstubAllGlobals()
  })

  it('plays to the end, however long, and can be stopped', () => {
    vi.stubGlobal('Audio', FakeAudio)
    playUrl('/files/long.mp3', 0.5)
    playUrl('/files/short.mp3', 0.5)
    expect(useSoundsPlaying.getState().count).toBe(2)

    FakeAudio.made[1].onended!()
    expect(useSoundsPlaying.getState().count).toBe(1)
    expect(FakeAudio.made[0].paused).toBe(false)

    stopSounds()
    expect(useSoundsPlaying.getState().count).toBe(0)
    expect(FakeAudio.made[0].paused).toBe(true)
  })
})
