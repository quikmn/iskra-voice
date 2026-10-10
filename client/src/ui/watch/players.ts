// The two kinds of player a watch party drives: a plain <video> and YouTube's IFrame Player API.

export interface PlayerAdapter {
  time(): number
  duration(): number
  paused(): boolean
  /** Rejects when the browser blocks playback until the user clicks. */
  play(): Promise<void>
  pause(): void
  seek(seconds: number): void
  setRate(rate: number): void
  setVolume(volume: number, muted: boolean): void
  /** Smooth small speed changes are possible (not on YouTube, whose speeds are coarse steps). */
  canNudge: boolean
}

export function videoAdapter(video: HTMLVideoElement): PlayerAdapter {
  return {
    time: () => video.currentTime,
    duration: () => (Number.isFinite(video.duration) ? video.duration : 0),
    paused: () => video.paused,
    play: () => video.play(),
    pause: () => video.pause(),
    seek: (s) => {
      video.currentTime = s
    },
    setRate: (r) => {
      if (Math.abs(video.playbackRate - r) > 0.001) video.playbackRate = r
    },
    setVolume: (v, muted) => {
      video.volume = v
      video.muted = muted
    },
    canNudge: true,
  }
}

// ── YouTube (official IFrame Player API, privacy-enhanced youtube-nocookie.com embeds) ──

interface YTPlayer {
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getPlaybackRate(): number
  setPlaybackRate(rate: number): void
  setVolume(volume: number): void
  mute(): void
  unMute(): void
  destroy(): void
}

interface YTNamespace {
  Player: new (element: HTMLIFrameElement, options: { events: { onReady?: () => void; onError?: (e: { data: number }) => void } }) => YTPlayer
  PlayerState: { PLAYING: number; BUFFERING: number }
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

export const YOUTUBE_API = 'https://www.youtube.com/iframe_api'
let loading: Promise<YTNamespace> | null = null

/** Loads YouTube's IFrame Player API once (the only third-party script the app allows, see the CSP). */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  loading ??= new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT) resolve(window.YT)
    }
    const script = document.createElement('script')
    script.src = YOUTUBE_API
    script.async = true
    script.onerror = () => {
      loading = null
      reject(new Error("Couldn't load YouTube's player."))
    }
    document.head.appendChild(script)
  })
  return loading
}

/** The embed URL for our own iframe (the API then attaches to it). No autoplay, no YouTube controls: the party drives it. */
export function youTubeEmbedUrl(videoId: string, origin: string): string {
  const params = new URLSearchParams({ enablejsapi: '1', controls: '0', disablekb: '1', playsinline: '1', rel: '0', iv_load_policy: '3' })
  if (origin.startsWith('http')) params.set('origin', origin)
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params}`
}

export function youTubeAdapter(yt: YTNamespace, player: YTPlayer): PlayerAdapter {
  return {
    time: () => player.getCurrentTime() ?? 0,
    duration: () => player.getDuration() ?? 0,
    paused: () => ![yt.PlayerState.PLAYING, yt.PlayerState.BUFFERING].includes(player.getPlayerState()),
    play: async () => player.playVideo(),
    pause: () => player.pauseVideo(),
    seek: (s) => player.seekTo(s, true),
    setRate: (r) => {
      if (player.getPlaybackRate() !== r) player.setPlaybackRate(r)
    },
    setVolume: (v, muted) => {
      player.setVolume(Math.round(v * 100))
      if (muted) player.mute()
      else player.unMute()
    },
    canNudge: false,
  }
}

export type { YTPlayer, YTNamespace }
