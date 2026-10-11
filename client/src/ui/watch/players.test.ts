import { describe, expect, it } from 'vitest'
import { initialYouTubeInfo, readYouTubeMessage, youTubeEmbedUrl, youTubeTime } from './players'

describe('YouTube embed bridge', () => {
  it('reads the player messages and ignores anything else', () => {
    let info = initialYouTubeInfo()
    expect(readYouTubeMessage(info, 'not json', 0)).toBe(info)
    expect(readYouTubeMessage(info, { event: 'onReady' }, 0)).toBe(info) // not a string
    expect(readYouTubeMessage(info, JSON.stringify({ event: 'somethingElse' }), 0)).toBe(info)
    info = readYouTubeMessage(info, JSON.stringify({ event: 'initialDelivery', info: { currentTime: 3, playerState: 2, duration: 600, playbackRate: 1 } }), 1000)
    expect(info).toMatchObject({ ready: true, time: 3, at: 1000, state: 2, duration: 600 })
    info = readYouTubeMessage(info, JSON.stringify({ event: 'onStateChange', info: 1 }), 2000)
    expect(info.state).toBe(1)
    info = readYouTubeMessage(info, JSON.stringify({ event: 'onError', info: 150 }), 2000)
    expect(info.error).toBe(150)
  })

  it('extrapolates the time while playing', () => {
    const info = { ...initialYouTubeInfo(), ready: true, time: 10, at: 1000, state: 1, rate: 2 }
    expect(youTubeTime(info, 2000)).toBe(12)
    expect(youTubeTime({ ...info, state: 2 }, 2000)).toBe(10)
  })

  it('embeds youtube-nocookie with the JS API on and no controls', () => {
    const url = new URL(youTubeEmbedUrl('aqz-KE-bpKQ', 'http://localhost:5173'))
    expect(url.origin).toBe('https://www.youtube-nocookie.com')
    expect(url.searchParams.get('enablejsapi')).toBe('1')
    expect(url.searchParams.get('controls')).toBe('0')
    expect(url.searchParams.get('origin')).toBe('http://localhost:5173')
    expect(new URL(youTubeEmbedUrl('x', 'app://iskra')).searchParams.has('origin')).toBe(false)
  })
})
