import { describe, expect, it } from 'vitest'
import { isAudioish, itemTitle, moveTarget, sourceKey, youTubeThumb } from './watchQueueLogic'

const names = { youtube: 'YouTube video', video: 'Video' }
const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('listen together queue', () => {
  it('names items by title, then by file name, then by kind', () => {
    expect(itemTitle({ kind: 'url', url: 'https://x.example/a.mp3', title: 'Song' }, names)).toBe('Song')
    expect(itemTitle({ kind: 'url', url: 'https://x.example/sets/My%20Mix.mp3?dl=1', title: null }, names)).toBe('My Mix.mp3')
    expect(itemTitle({ kind: 'youtube', url: null, title: null }, names)).toBe('YouTube video')
    expect(itemTitle({ kind: 'url', url: 'https://x.example/', title: null }, names)).toBe('Video')
  })

  it('tells audio from video by the name', () => {
    expect(isAudioish({ kind: 'url', url: 'https://x.example/a.mp3', title: null })).toBe(true)
    expect(isAudioish({ kind: 'file', url: '/files/1/x', title: 'take.flac' })).toBe(true)
    expect(isAudioish({ kind: 'url', url: 'https://x.example/film.mp4', title: null })).toBe(false)
    expect(isAudioish({ kind: 'youtube', url: null, title: 'song.mp3' })).toBe(false)
  })

  it('works out where a stepped item lands', () => {
    expect(moveTarget(queue, 'a', -1)).toBeNull()
    expect(moveTarget(queue, 'b', -1)).toEqual({ before: 'a' })
    expect(moveTarget(queue, 'a', 1)).toEqual({ before: 'c' })
    expect(moveTarget(queue, 'b', 1)).toEqual({ before: null })
    expect(moveTarget(queue, 'c', 1)).toBeNull()
    expect(moveTarget(queue, 'zz', 1)).toBeNull()
  })

  it('keys sources and finds YouTube stills', () => {
    expect(sourceKey({ kind: 'youtube', url: null, videoId: 'dQw4w9WgXcQ' })).toBe('youtube:dQw4w9WgXcQ')
    expect(sourceKey({ kind: 'url', url: 'https://x.example/a.mp3', videoId: null })).toBe('url:https://x.example/a.mp3')
    expect(youTubeThumb('dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg')
  })
})
