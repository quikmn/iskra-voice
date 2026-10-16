// The two kinds of player a watch party drives: a plain <video> and YouTube's embed (over postMessage).

export interface PlayerAdapter {
  time(): number
  duration(): number
  paused(): boolean
  /** Played to the end (listen together moves on to the next queued item). */
  ended(): boolean
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
    ended: () => video.ended,
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

// ── YouTube (privacy-enhanced youtube-nocookie.com embed, driven over postMessage) ──
// No YouTube script ever runs in the app's own page (it could read keys there). The embed runs in its own sandboxed
// frame; we send it the IFrame Player API's postMessage commands and listen to the state it reports back.

export const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com'

/** What the player has told us so far. */
export interface YouTubeInfo {
  ready: boolean
  time: number
  /** When `time` was reported (ms). */
  at: number
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. */
  state: number
  duration: number
  rate: number
  error: number | null
}

export const initialYouTubeInfo = (): YouTubeInfo => ({ ready: false, time: 0, at: 0, state: -1, duration: 0, rate: 1, error: null })

/**
 * Folds one message from the embed into what we know. Anything that isn't the player's JSON is ignored
 * (returns `info` unchanged). Callers check the message's origin and source window first.
 */
export function readYouTubeMessage(info: YouTubeInfo, raw: unknown, now: number): YouTubeInfo {
  if (typeof raw !== 'string' || raw.length > 100_000) return info
  let data: { event?: unknown; info?: unknown }
  try {
    data = JSON.parse(raw)
  } catch {
    return info
  }
  if (!data || typeof data !== 'object') return info
  const next = { ...info }
  if (data.event === 'onReady') next.ready = true
  else if (data.event === 'onStateChange' && typeof data.info === 'number') next.state = data.info
  else if (data.event === 'onError' && typeof data.info === 'number') next.error = data.info
  else if ((data.event === 'infoDelivery' || data.event === 'initialDelivery') && data.info && typeof data.info === 'object') {
    const i = data.info as Record<string, unknown>
    next.ready = true
    if (typeof i.currentTime === 'number' && Number.isFinite(i.currentTime)) {
      next.time = i.currentTime
      next.at = now
    }
    if (typeof i.playerState === 'number') next.state = i.playerState
    if (typeof i.duration === 'number' && Number.isFinite(i.duration) && i.duration > 0) next.duration = i.duration
    if (typeof i.playbackRate === 'number' && i.playbackRate > 0) next.rate = i.playbackRate
  } else return info
  return next
}

/** The player's position now, extrapolated from its last report while it plays. */
export function youTubeTime(info: YouTubeInfo, now: number): number {
  const playing = info.state === 1
  return info.time + (playing && info.at > 0 ? ((now - info.at) / 1000) * info.rate : 0)
}

/** The embed frame's attributes: sandboxed (no popups, no navigating the app), allowed to play and go fullscreen. */
export const YOUTUBE_FRAME = {
  allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
  referrerPolicy: 'strict-origin-when-cross-origin',
  sandbox: 'allow-scripts allow-same-origin allow-presentation',
} as const

/** The embed URL. No autoplay, no YouTube controls: the party drives it. `origin` lets the player post back to us. */
export function youTubeEmbedUrl(videoId: string, origin: string): string {
  const params = new URLSearchParams({ enablejsapi: '1', controls: '0', disablekb: '1', playsinline: '1', rel: '0', iv_load_policy: '3' })
  if (origin.startsWith('http')) params.set('origin', origin)
  return `${YOUTUBE_ORIGIN}/embed/${encodeURIComponent(videoId)}?${params}`
}

/** Talks to one embed frame: commands out, state in. */
export class YouTubeBridge {
  info: YouTubeInfo = initialYouTubeInfo()
  private readonly frame: HTMLIFrameElement

  constructor(frame: HTMLIFrameElement) {
    this.frame = frame
  }

  private post(message: object): void {
    this.frame.contentWindow?.postMessage(JSON.stringify({ ...message, id: 1, channel: 'widget' }), YOUTUBE_ORIGIN)
  }

  /** Asks the player to start reporting (repeat until it's ready). */
  listen(): void {
    this.post({ event: 'listening' })
  }

  command(func: string, args: unknown[] = []): void {
    this.post({ event: 'command', func, args })
  }

  /** Feeds a window message in; true if it came from this frame's player. */
  receive(e: MessageEvent): boolean {
    if (e.origin !== YOUTUBE_ORIGIN || e.source !== this.frame.contentWindow) return false
    this.info = readYouTubeMessage(this.info, e.data, Date.now())
    return true
  }

  adapter(): PlayerAdapter {
    return {
      time: () => youTubeTime(this.info, Date.now()),
      duration: () => this.info.duration,
      paused: () => this.info.state !== 1 && this.info.state !== 3,
      ended: () => this.info.state === 0,
      play: async () => {
        this.command('playVideo')
        this.info = { ...this.info, state: 1, at: Date.now() }
      },
      pause: () => {
        this.info = { ...this.info, time: youTubeTime(this.info, Date.now()), state: 2 }
        this.command('pauseVideo')
      },
      seek: (s) => {
        this.command('seekTo', [s, true])
        this.info = { ...this.info, time: s, at: Date.now() }
      },
      setRate: (r) => {
        if (this.info.rate !== r) {
          this.command('setPlaybackRate', [r])
          this.info = { ...this.info, rate: r }
        }
      },
      setVolume: (v, muted) => {
        this.command('setVolume', [Math.round(v * 100)])
        this.command(muted ? 'mute' : 'unMute')
      },
      canNudge: false,
    }
  }
}
