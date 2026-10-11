import { describe, expect, it } from 'vitest'
import { embedFor } from './embeds'

const e = (url: string) => embedFor(url, 'app.iskra.foo')

describe('link embeds', () => {
  it('knows YouTube links in all their shapes', () => {
    const src = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1'
    expect(e('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.src).toBe(src)
    expect(e('https://youtu.be/dQw4w9WgXcQ')?.src).toBe(src)
    expect(e('https://m.youtube.com/shorts/dQw4w9WgXcQ')?.src).toBe(src)
    expect(e('https://youtu.be/dQw4w9WgXcQ?t=1m30s')?.src).toBe(`${src}&start=90`)
    expect(e('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(e('https://www.youtube.com/@channel')).toBeNull()
  })

  it('knows Twitch channels, clips and videos (with this app as the parent)', () => {
    expect(e('https://www.twitch.tv/somestreamer')?.src).toBe('https://player.twitch.tv/?channel=somestreamer&parent=app.iskra.foo&autoplay=true')
    expect(e('https://clips.twitch.tv/FunnyClip-abc')?.src).toContain('clips.twitch.tv/embed?clip=FunnyClip-abc')
    expect(e('https://www.twitch.tv/x/clip/FunnyClip-abc')?.src).toContain('clip=FunnyClip-abc')
    expect(e('https://www.twitch.tv/videos/123456')?.src).toContain('video=123456')
    expect(e('https://www.twitch.tv/directory/game/x')).toBeNull()
  })

  it('knows posts on X and Reddit', () => {
    expect(e('https://x.com/someone/status/1234567890')?.src).toBe('https://platform.twitter.com/embed/Tweet.html?id=1234567890&dnt=true&theme=dark')
    expect(e('https://twitter.com/someone/status/1234567890?s=20')?.provider).toBe('X')
    expect(e('https://www.reddit.com/r/aww/comments/abc123/cute_cat/')?.src).toBe('https://embed.reddit.com/r/aww/comments/abc123/?embed=true&theme=dark')
    expect(e('https://www.reddit.com/r/aww/')).toBeNull()
  })

  it('never builds an iframe address from untrusted parts', () => {
    expect(e('https://evil.example/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(e('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(e('javascript:alert(1)')).toBeNull()
    expect(e('https://x.com/a/status/1"onload="x')).toBeNull()
    expect(e('https://www.reddit.com/r/a"b/comments/abc/')).toBeNull()
  })
})
