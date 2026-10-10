import { describe, expect, it } from 'vitest'
import { bestOffset, clockSample, correction, formatTime, parseWatchInput, positionAt, youTubeId } from './watchSync'

describe('watch party clock', () => {
  const party = { playing: true, position: 30, rate: 1, updatedAt: 10_000 }

  it('moves on from the last update while playing, at the party speed', () => {
    expect(positionAt(party, 12_500)).toBe(32.5)
    expect(positionAt({ ...party, rate: 2 }, 12_500)).toBe(35)
    expect(positionAt({ ...party, playing: false }, 99_000)).toBe(30)
    expect(positionAt(party, 9_000)).toBe(30) // a clock slightly behind never goes backwards
  })

  it('lands a late joiner where everyone else is', () => {
    // Started 90 s ago (server clock); our clock is 4 s behind the server's.
    const offset = bestOffset([clockSample(1_000, 5_050, 1_100)])
    expect(offset).toBe(3_000 + 1_000)
    const localNow = 96_000
    expect(positionAt({ playing: true, position: 0, rate: 1, updatedAt: 10_000 }, localNow + offset)).toBe(90)
  })

  it('trusts the sample with the shortest round trip', () => {
    const samples = [clockSample(0, 900, 1_000), clockSample(2_000, 2_520, 2_040), clockSample(3_000, 3_700, 3_400)]
    expect(bestOffset(samples)).toBe(500)
    expect(bestOffset([])).toBe(0)
  })
})

describe('drift correction', () => {
  it('leaves small drift alone', () => {
    expect(correction(10.1, 10, 1, true, true)).toEqual({ kind: 'none' })
  })

  it('nudges the speed for medium drift, the right way round', () => {
    expect(correction(10.5, 10, 1, true, true)).toEqual({ kind: 'nudge', rate: 0.95 }) // ahead: slow down
    expect(correction(9.5, 10, 1.5, true, true)).toEqual({ kind: 'nudge', rate: 1.5 * 1.05 }) // behind: speed up
  })

  it('jumps when far off, or when the player can only jump', () => {
    expect(correction(14, 10, 1, true, true)).toEqual({ kind: 'seek', to: 10 })
    expect(correction(10.5, 10, 1, true, false)).toEqual({ kind: 'none' })
    expect(correction(12, 10, 1, true, false)).toEqual({ kind: 'seek', to: 10 })
  })

  it('snaps to the paused position', () => {
    expect(correction(42, 40, 1, false, true)).toEqual({ kind: 'seek', to: 40 })
    expect(correction(40.1, 40, 1, false, true)).toEqual({ kind: 'none' })
  })
})

describe('watch links', () => {
  it('finds YouTube video ids in the usual link shapes', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) expect(youTubeId(link)).toBe('dQw4w9WgXcQ')
    expect(youTubeId('https://evil.example/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(youTubeId('https://www.youtube.com/watch?v=short')).toBeNull()
  })

  it('accepts YouTube and https media links only', () => {
    expect(parseWatchInput(' https://youtu.be/dQw4w9WgXcQ ')).toEqual({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' })
    expect(parseWatchInput('https://cdn.example.com/film.mp4')).toEqual({ kind: 'url', url: 'https://cdn.example.com/film.mp4' })
    expect(parseWatchInput('http://cdn.example.com/film.mp4')).toBeNull()
    expect(parseWatchInput('javascript:alert(1)')).toBeNull()
    expect(parseWatchInput('https://user:pw@cdn.example.com/a.mp4')).toBeNull()
    expect(parseWatchInput('not a link')).toBeNull()
  })

  it('formats times', () => {
    expect(formatTime(7.9)).toBe('0:07')
    expect(formatTime(245)).toBe('4:05')
    expect(formatTime(3723)).toBe('1:02:03')
    expect(formatTime(NaN)).toBe('0:00')
  })
})
