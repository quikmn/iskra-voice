// Video and post embeds for well-known sites. Nothing loads from them until you click: the card shows the server's
// link preview (fetched by the server, so your address isn't sent), and only "Play"/"Load" swaps in their player.

export type Provider = 'YouTube' | 'Twitch' | 'X' | 'Reddit'

export interface Embed {
  provider: Provider
  /** The iframe address (built from the parsed id, never copied from the message). */
  src: string
  /** Video players are 16:9; posts get a fixed height. */
  shape: 'video' | 'post'
}

const ID = /^[\w-]+$/

function parse(url: string): URL | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '')

/** Seconds from YouTube's t= (90, 90s, 1m30s). */
function startSeconds(t: string | null): number {
  if (!t) return 0
  if (/^\d+$/.test(t)) return Number(t)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0
}

/** The embed for a link, or null. `pageHost` is this app's host name (Twitch requires it). */
export function embedFor(url: string, pageHost: string): Embed | null {
  const u = parse(url)
  if (!u) return null
  const h = host(u)
  const parts = u.pathname.split('/').filter(Boolean)

  if (h === 'youtube.com' || h === 'youtu.be' || h === 'music.youtube.com') {
    const id = h === 'youtu.be' ? parts[0]
      : parts[0] === 'watch' ? u.searchParams.get('v')
        : ['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : null
    if (!id || !/^[\w-]{11}$/.test(id)) return null
    const start = startSeconds(u.searchParams.get('t') ?? u.searchParams.get('start'))
    return { provider: 'YouTube', shape: 'video', src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1${start ? `&start=${start}` : ''}` }
  }

  if (h === 'twitch.tv' || h === 'clips.twitch.tv') {
    const parent = encodeURIComponent(pageHost)
    if (h === 'clips.twitch.tv' && parts[0] && ID.test(parts[0])) return twitch(`https://clips.twitch.tv/embed?clip=${parts[0]}&parent=${parent}`)
    if (parts[1] === 'clip' && parts[2] && ID.test(parts[2])) return twitch(`https://clips.twitch.tv/embed?clip=${parts[2]}&parent=${parent}`)
    if (parts[0] === 'videos' && /^\d+$/.test(parts[1] ?? '')) return twitch(`https://player.twitch.tv/?video=${parts[1]}&parent=${parent}`)
    if (parts.length === 1 && /^\w{3,25}$/.test(parts[0])) return twitch(`https://player.twitch.tv/?channel=${parts[0]}&parent=${parent}`)
    return null
  }

  if (h === 'x.com' || h === 'twitter.com') {
    const status = parts[1] === 'status' ? parts[2] : null
    if (!status || !/^\d{1,25}$/.test(status)) return null
    return { provider: 'X', shape: 'post', src: `https://platform.twitter.com/embed/Tweet.html?id=${status}&dnt=true&theme=dark` }
  }

  if (h === 'reddit.com' || h === 'old.reddit.com') {
    if (parts[0] !== 'r' || !ID.test(parts[1] ?? '') || parts[2] !== 'comments' || !/^[a-z0-9]{1,12}$/i.test(parts[3] ?? '')) return null
    return { provider: 'Reddit', shape: 'post', src: `https://embed.reddit.com/r/${parts[1]}/comments/${parts[3]}/?embed=true&theme=dark` }
  }
  return null
}

const twitch = (src: string): Embed => ({ provider: 'Twitch', shape: 'video', src: `${src}&autoplay=true` })
