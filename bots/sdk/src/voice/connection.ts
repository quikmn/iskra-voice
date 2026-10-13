// A bot in a voice channel: one LiveKit audio track it plays files and streams into, one at a time.
import type { Channel, Events } from '../../../../client/src/core/protocol'
import { applyVolume, CHANNELS, concat, createDecoder, FORMATS, Framer, FRAME, RATE, sniff, SNIFF_BYTES, toStereo, type Decoder } from './audio'
import { loadRtc, type Decoded, type Rtc, type RtcAudioSource, type RtcResampler, type RtcRoom } from './modules'
import { openSource, type AudioInput } from './source'

export interface Track {
  /** What `nowPlaying` shows: the title you gave, or the file's name or the stream's address. */
  title: string
  input: AudioInput
}

/** Why a track ended: it played to the end, `stop()`/`skip()`, another `play()`, an error, or the bot left voice. */
export type TrackEndReason = 'finished' | 'stopped' | 'replaced' | 'error' | 'left'

export interface TrackEnd {
  track: Track
  reason: TrackEndReason
  error?: Error
}

export interface PlayOptions {
  /** A name to show (default: the file's name or the address). */
  title?: string
}

/** Why the bot is no longer in voice. */
export interface VoiceGone {
  channelId: number
  /** `kicked`: a moderator disconnected it, or it lost the right to be there. `dropped`: voice went away (a restart, the network). */
  reason: 'kicked' | 'dropped'
}

interface VoiceListeners {
  trackStart: (track: Track) => void
  trackEnd: (end: TrackEnd) => void
  /** A moderator took the bot out of voice (or an admin turned voice off for it). It doesn't rejoin by itself. */
  kicked: (gone: VoiceGone) => void
  /** Voice dropped for another reason (LiveKit restarted, the network). Call `bot.joinVoice` again to come back. */
  disconnected: (gone: VoiceGone) => void
}

export type VoiceState = 'connecting' | 'idle' | 'playing' | 'paused' | 'left'

/** Joined with `bot.joinVoice(channelId)`. */
export class VoiceConnection {
  readonly channelId: number
  private stateNow: VoiceState = 'connecting'
  private volumeNow = 1
  private current: { track: Track; abort: AbortController; done: Promise<TrackEnd> } | null = null
  private wake: (() => void) | null = null
  private resumed: Promise<void> | null = null
  private room: RtcRoom | null = null
  private source: RtcAudioSource | null = null
  private audioTrack: { close(closeSource?: boolean): Promise<void> } | null = null
  private publishedSid: string | null = null
  private canSpeak = false
  private readonly listeners: { [K in keyof VoiceListeners]: VoiceListeners[K][] } = { trackStart: [], trackEnd: [], kicked: [], disconnected: [] }
  private rtc!: Rtc
  private readonly me: string
  private readonly serverUrl: string
  private readonly channel: () => Channel | undefined
  private readonly log: (line: string) => void
  private readonly onGone: () => void

  /** @internal Use `bot.joinVoice`. */
  constructor(channelId: number, me: string, serverUrl: string, channel: () => Channel | undefined, log: (line: string) => void, onGone: () => void) {
    this.channelId = channelId
    this.me = me
    this.serverUrl = serverUrl
    this.channel = channel
    this.log = log
    this.onGone = onGone
  }

  on<K extends keyof VoiceListeners>(event: K, listener: VoiceListeners[K]): this {
    this.listeners[event].push(listener)
    return this
  }

  get state(): VoiceState {
    return this.stateNow
  }

  /** What's playing (or paused), or null. */
  get nowPlaying(): Track | null {
    return this.current?.track ?? null
  }

  get volume(): number {
    return this.volumeNow
  }

  /** 0 (silent) to 2 (twice as loud); 1 plays as recorded. Applies within a fraction of a second. */
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) throw new Error('Volume must be a number from 0 to 2.')
    this.volumeNow = Math.min(2, Math.max(0, volume))
  }

  /** @internal Connects to LiveKit with the token from `voice.join` and publishes the bot's audio track. */
  async connect(joined: { url: string; token: string; canSpeak: boolean }): Promise<void> {
    this.rtc = await loadRtc()
    const room = new this.rtc.Room()
    this.room = room
    room.on('disconnected', (reason) => {
      if (this.stateNow === 'left') return
      const removed = reason === this.rtc.DisconnectReason.PARTICIPANT_REMOVED || reason === this.rtc.DisconnectReason.ROOM_DELETED
      void this.gone(removed ? 'kicked' : 'dropped')
    })
    room.on('localTrackUnpublished', (publication) => {
      if (publication.sid === this.publishedSid) this.publishedSid = null // a server mute takes publishing away
    })
    await room.connect(joined.url, joined.token, { autoSubscribe: false, dynacast: false })
    this.source = new this.rtc.AudioSource(RATE, CHANNELS, 200)
    this.audioTrack = this.rtc.LocalAudioTrack.createAudioTrack('music', this.source)
    this.canSpeak = joined.canSpeak
    if (this.canSpeak) await this.publish()
    else this.log("Joined voice, but can't be heard there (no permission to speak, or server-muted).")
    this.stateNow = 'idle'
  }

  private async publish(): Promise<void> {
    if (!this.room?.localParticipant || !this.audioTrack || this.publishedSid) return
    const hifi = this.channel()?.hifi === true
    const options = new this.rtc.TrackPublishOptions({
      source: this.rtc.TrackSource.SOURCE_MICROPHONE,
      dtx: false, // music has no pauses to skip
      red: true,
      audioEncoding: { maxBitrate: BigInt(hifi ? 128_000 : 96_000) },
    })
    const publication = await this.room.localParticipant.publishTrack(this.audioTrack, options)
    this.publishedSid = publication.sid ?? null
  }

  /** @internal The channel's voice state from the server: publish again when a server mute is lifted. */
  voiceState(state: Events['voice.state']): void {
    if (state.channelId !== this.channelId || this.stateNow === 'left') return
    const mine = state.participants.find((p) => p.accountKey === this.me)
    if (!mine) return
    const muted = (mine as { serverMuted?: boolean }).serverMuted === true
    if (muted || this.publishedSid) return
    // The server tells LiveKit first; give it a moment to apply before publishing again.
    void (async () => {
      for (let attempt = 0; attempt < 5 && !this.publishedSid && this.stateNow !== 'left'; attempt++) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
        try {
          await this.publish()
        } catch {
          /* not allowed yet */
        }
      }
    })()
  }

  /**
   * Plays a file or stream, replacing whatever is playing. Resolves when it ends (see `TrackEnd.reason`); errors
   * (an unknown format, an address that doesn't answer) end it with reason `error` instead of throwing.
   * Formats: MP3, Ogg Opus, Ogg Vorbis, FLAC and WAV, recognized from their first bytes.
   */
  play(input: AudioInput, options: PlayOptions = {}): Promise<TrackEnd> {
    if (this.stateNow === 'left' || this.stateNow === 'connecting') return Promise.reject(new Error('Not in a voice channel.'))
    this.end('replaced')
    const track: Track = { title: options.title ?? '', input }
    const abort = new AbortController()
    const done = this.run(track, abort.signal).then(
      (): TrackEnd => ({ track, reason: abort.signal.aborted ? reasonOf(abort.signal) : 'finished' }),
      (error: Error): TrackEnd => (abort.signal.aborted ? { track, reason: reasonOf(abort.signal) } : { track, reason: 'error', error }),
    ).then((end) => {
      if (this.current?.done === done) {
        this.current = null
        if (this.stateNow !== 'left') this.stateNow = 'idle'
      }
      if (end.error) this.log(`Couldn't play ${end.track.title || 'that'}: ${end.error.message}`)
      for (const l of this.listeners.trackEnd) l(end)
      return end
    })
    this.current = { track, abort, done }
    this.stateNow = 'playing'
    this.releasePause()
    return done
  }

  /** Stops what's playing (it ends with reason `stopped`). The bot stays in the channel. */
  stop(): void {
    this.end('stopped')
  }

  /** Pauses; `resume()` goes on from there (a live stream goes on from where the bot stopped reading it). */
  pause(): void {
    if (this.stateNow !== 'playing') return
    this.stateNow = 'paused'
    this.resumed = new Promise((r) => (this.wake = r))
    this.source?.clearQueue()
  }

  resume(): void {
    if (this.stateNow !== 'paused') return
    this.stateNow = 'playing'
    this.releasePause()
  }

  /** Leaves the voice channel (what's playing ends with reason `left`). */
  async leave(): Promise<void> {
    if (this.stateNow === 'left') return
    await this.gone(null)
  }

  /** @internal The server said the bot was taken out of voice. */
  removed(): void {
    if (this.stateNow !== 'left') void this.gone('kicked')
  }

  private releasePause(): void {
    this.wake?.()
    this.wake = null
    this.resumed = null
  }

  private end(reason: TrackEndReason): void {
    if (!this.current) return
    this.current.abort.abort(reason)
    this.source?.clearQueue()
    this.releasePause()
  }

  private async gone(why: VoiceGone['reason'] | null): Promise<void> {
    this.end('left')
    this.stateNow = 'left'
    this.onGone()
    const room = this.room
    this.room = null
    try {
      await this.audioTrack?.close(false)
      await this.source?.close()
      if (room?.isConnected) await room.disconnect()
    } catch (e) {
      this.log(`Leaving voice: ${(e as Error).message}`)
    }
    if (why) for (const l of this.listeners[why === 'kicked' ? 'kicked' : 'disconnected']) l({ channelId: this.channelId, reason: why })
  }

  // ── Playing ──────────────────────────────────────────────────────────────

  private async run(track: Track, signal: AbortSignal): Promise<void> {
    const opened = await openSource(track.input, this.serverUrl, signal)
    if (!track.title) track.title = opened.title
    const reader = opened.chunks[Symbol.asyncIterator]()
    let decoder: Decoder | null = null
    const out = new Output(this.rtc, (frame) => this.capture(frame, signal))
    try {
      let head: Uint8Array = new Uint8Array(0)
      while (head.length < SNIFF_BYTES && !signal.aborted) {
        const next = await reader.next()
        if (next.done) break
        head = concat(head, next.value)
      }
      if (signal.aborted) return
      if (head.length === 0) throw new Error('There was nothing to play.')
      const format = sniff(head)
      if (typeof format !== 'string') throw new Error(`Can't play ${format.unsupported}; bots play ${FORMATS}.`)
      decoder = await createDecoder(format)
      for (const l of this.listeners.trackStart) l(track)
      await out.write(await decoder.push(head))
      while (!signal.aborted) {
        const next = await reader.next()
        if (next.done) break
        await out.write(await decoder.push(next.value))
      }
      if (signal.aborted) return
      await out.write(await decoder.end())
      await out.finish()
      if (!signal.aborted) await this.source?.waitForPlayout()
    } finally {
      decoder?.free()
      out.close()
      void reader.return?.()
    }
  }

  private async capture(samples: Int16Array, signal: AbortSignal): Promise<void> {
    while (this.resumed && !signal.aborted) await this.resumed
    if (signal.aborted || !this.source) return
    applyVolume(samples, this.volumeNow)
    await this.source.captureFrame(new this.rtc.AudioFrame(samples, RATE, CHANNELS, FRAME))
  }
}

const reasonOf = (signal: AbortSignal): TrackEndReason =>
  (['stopped', 'replaced', 'left'] as const).find((r) => r === signal.reason) ?? 'stopped'

/** Decoded audio → 48 kHz stereo (resampled when needed) → 10 ms frames. */
class Output {
  private resampler: RtcResampler | null = null
  private rate = RATE
  private readonly framer = new Framer()
  private readonly rtc: Rtc
  private readonly send: (frame: Int16Array) => Promise<void>

  constructor(rtc: Rtc, send: (frame: Int16Array) => Promise<void>) {
    this.rtc = rtc
    this.send = send
  }

  async write(decoded: Decoded[]): Promise<void> {
    for (const d of decoded) {
      const stereo = toStereo(d)
      if (d.sampleRate !== this.rate) {
        await this.drain()
        this.rate = d.sampleRate
        this.resampler = this.rate === RATE ? null : new this.rtc.AudioResampler(this.rate, RATE, CHANNELS, this.rtc.AudioResamplerQuality.HIGH)
      }
      if (!this.resampler) await this.frames(stereo)
      else for (const f of this.resampler.push(new this.rtc.AudioFrame(stereo, this.rate, CHANNELS, d.samplesDecoded))) await this.frames(f.data)
    }
  }

  async finish(): Promise<void> {
    await this.drain()
    for (const f of this.framer.flush()) await this.send(f)
  }

  close(): void {
    this.resampler?.close()
    this.resampler = null
  }

  private async drain(): Promise<void> {
    if (!this.resampler) return
    for (const f of this.resampler.flush()) await this.frames(f.data)
    this.resampler.close()
    this.resampler = null
  }

  private async frames(samples: Int16Array): Promise<void> {
    for (const f of this.framer.push(samples)) await this.send(f)
  }
}
