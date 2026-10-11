import { describe, expect, it } from 'vitest'
import { liveWebm, muxWebm, readWebm, WebmReader, type Frame, type TrackInfo } from './webm'
import { clampSeconds, clampTrim, clipWindow, FrameRing, keyframeAtOrBefore, trimDraft } from './ring'

const audioInfo: TrackInfo = { type: 'audio', codec: 'A_OPUS', entry: new Uint8Array([0x83, 0x81, 0x02, 0x86, 0x86, ...new TextEncoder().encode('A_OPUS')]) }
const videoInfo: TrackInfo = { type: 'video', codec: 'V_VP8', entry: new Uint8Array([0x83, 0x81, 0x01, 0x86, 0x85, ...new TextEncoder().encode('V_VP8')]) }
const frame = (time: number, key = true, size = 10): Frame => ({ time, key, flags: key ? 0x80 : 0, data: new Uint8Array(size).fill(time % 251) })

describe('WebM reader', () => {
  const file = liveWebm(
    [{ type: 'video', codec: 'V_VP8' }, { type: 'audio', codec: 'A_OPUS' }],
    [
      { time: 0, blocks: [{ track: 1, at: 0, key: true, data: [1, 2, 3] }, { track: 2, at: 5, key: true, data: [9] }, { track: 1, at: 33, key: false, data: [4] }] },
      { time: 1000, blocks: [{ track: 1, at: 1000, key: true, data: [5, 6] }, { track: 2, at: 980 + 40, key: true, data: [8, 8] }] },
    ],
  )

  it('reads tracks and frames from a live recording', () => {
    const { tracks, frames } = readWebm(file)
    expect(tracks.map((t) => [t.type, t.codec])).toEqual([['video', 'V_VP8'], ['audio', 'A_OPUS']])
    expect(frames.map(({ track, frame }) => [track, frame.time, frame.key, [...frame.data]])).toEqual([
      [0, 0, true, [1, 2, 3]], [1, 5, true, [9]], [0, 33, false, [4]], [0, 1000, true, [5, 6]], [1, 1020, true, [8, 8]],
    ])
  })

  it('gives the same result however the bytes are split', () => {
    const whole = readWebm(file).frames.map((f) => [f.track, f.frame.time, [...f.frame.data]])
    for (const step of [1, 3, 7, 64]) {
      const reader = new WebmReader()
      const got: unknown[] = []
      reader.onFrame = (track, f) => got.push([track, f.time, [...f.data]])
      for (let i = 0; i < file.length; i += step) reader.push(file.subarray(i, i + step))
      expect(got).toEqual(whole)
    }
  })

  it('rejects bytes that are not WebM', () => {
    expect(() => new WebmReader().push(new Uint8Array([0, 0, 0, 0, 0]))).toThrow()
  })
})

describe('WebM writer', () => {
  it('round-trips frames, starting at 0, with a duration', () => {
    const video = [frame(5000), frame(5033, false), frame(7000), frame(7033, false)]
    const audio = [frame(5010), frame(5030), frame(7040)]
    const { bytes, duration } = muxWebm([{ info: audioInfo, frames: audio }, { info: videoInfo, frames: video }])
    expect(duration).toBe(2040 + 33)
    const back = readWebm(bytes)
    // Video is written first.
    expect(back.tracks.map((t) => t.codec)).toEqual(['V_VP8', 'A_OPUS'])
    expect(back.frames.map(({ track, frame }) => [track, frame.time, frame.key])).toEqual([
      [0, 0, true], [1, 10, true], [1, 30, true], [0, 33, false], [0, 2000, true], [0, 2033, false], [1, 2040, true],
    ])
    expect([...back.frames[0].frame.data]).toEqual([...video[0].data])
  })

  it('splits long audio into seekable clusters and keeps 16-bit block times in range', () => {
    const audio = Array.from({ length: 3000 }, (_, i) => frame(i * 20, true, 2)) // 60 s
    const { bytes } = muxWebm([{ info: audioInfo, frames: audio }])
    const back = readWebm(bytes)
    expect(back.frames).toHaveLength(3000)
    expect(back.frames.at(-1)!.frame.time).toBe(59_980)
  })

  it('writes an empty file for no frames', () => {
    expect(muxWebm([]).duration).toBe(0)
  })
})

describe('frame ring', () => {
  it('keeps only the last keepMs of audio', () => {
    const ring = new FrameRing(1000, 1e9)
    ring.clear(audioInfo)
    for (let t = 0; t <= 3000; t += 100) ring.add(frame(t))
    expect(ring.list()[0].time).toBe(2000)
    expect(ring.bytes).toBe(11 * 10)
  })

  it('keeps video from the keyframe the window depends on', () => {
    const ring = new FrameRing(1000, 1e9)
    ring.clear(videoInfo)
    for (let t = 0; t <= 3000; t += 100) ring.add(frame(t, t % 1500 === 0))
    // At 3000 the cutoff is 2000; the keyframe at or before it is 1500.
    expect(ring.list()[0]).toMatchObject({ time: 1500, key: true })
  })

  it('stays under its byte limit, dropping whole keyframe groups of video', () => {
    const ring = new FrameRing(60_000, 100)
    ring.clear(videoInfo)
    for (let t = 0; t < 20; t++) ring.add(frame(t * 100, t % 5 === 0))
    expect(ring.bytes).toBeLessThanOrEqual(100)
    expect(ring.list()[0].key).toBe(true)
  })

  it('compacts its storage over a long call', () => {
    const ring = new FrameRing(500, 1e9)
    ring.clear(audioInfo)
    for (let t = 0; t < 100_000; t += 20) ring.add(frame(t, true, 1))
    expect(ring.list().length).toBeLessThanOrEqual(26)
  })
})

describe('clip window and trimming', () => {
  const audio = { info: audioInfo, frames: Array.from({ length: 600 }, (_, i) => frame(i * 100)) } // 0–59.9 s
  const video = { info: videoInfo, frames: Array.from({ length: 600 }, (_, i) => frame(i * 100, i % 20 === 0)) } // keyframe every 2 s

  it('clamps the length setting', () => {
    expect([clampSeconds(5), clampSeconds(30), clampSeconds(500), clampSeconds(NaN)]).toEqual([15, 30, 120, 30])
  })

  it('finds the keyframe at or before a time', () => {
    expect(keyframeAtOrBefore(video.frames, 4100)).toBe(40)
    expect(keyframeAtOrBefore(video.frames, 4000)).toBe(40)
    expect(keyframeAtOrBefore([frame(10, false), frame(500)], 0)).toBe(1)
    expect(keyframeAtOrBefore([frame(10, false)], 100)).toBe(-1)
  })

  it('takes the last N seconds, starting video on a keyframe', () => {
    const draft = clipWindow(video, audio, 59_900, 30)!
    expect(draft.start).toBe(28_000) // want 29 900; keyframe at 28 000
    expect(draft.video!.frames[0]).toMatchObject({ time: 28_000, key: true })
    expect(draft.audio!.frames[0].time).toBe(28_000)
    expect(draft.duration).toBe(31_900)
  })

  it('works with audio only and with less history than asked for', () => {
    const draft = clipWindow(null, { info: audioInfo, frames: audio.frames.slice(0, 50) }, 4_900, 30)!
    expect(draft.video).toBeNull()
    expect(draft.start).toBe(0)
    expect(draft.duration).toBe(4_900)
    expect(clipWindow(null, null, 1000, 30)).toBeNull()
  })

  it('clamps a trim range', () => {
    expect(clampTrim(10_000, -5, 20_000)).toEqual({ from: 0, to: 10_000 })
    expect(clampTrim(10_000, 6_000, 3_000)).toEqual({ from: 3_000, to: 6_000 })
    expect(clampTrim(10_000, 9_800, 9_900)).toEqual({ from: 9_000, to: 10_000 })
    expect(clampTrim(500, 100, 200)).toEqual({ from: 0, to: 500 })
  })

  it('trims to a range, moving the start back to a keyframe', () => {
    const draft = clipWindow(video, audio, 59_900, 30)!
    const cut = trimDraft(draft, 5_000, 15_000)
    // 28 000 + 5 000 = 33 000; the keyframe before it is at 32 000.
    expect(cut.from).toBe(4_000)
    expect(cut.to).toBe(15_000)
    expect(cut.draft.start).toBe(32_000)
    expect(cut.draft.video!.frames[0]).toMatchObject({ time: 32_000, key: true })
    expect(cut.draft.audio!.frames.at(-1)!.time).toBe(43_000)
    expect(cut.draft.duration).toBe(11_000)
    const bytes = muxWebm([cut.draft.video!, cut.draft.audio!]).bytes
    expect(readWebm(bytes).frames[0].frame.time).toBe(0)
  })
})
