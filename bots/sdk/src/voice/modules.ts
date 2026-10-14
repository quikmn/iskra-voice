// The native and WebAssembly packages voice needs, loaded only when a bot uses voice. They live in bots/node_modules
// (`npm install` in bots/); the web client type-checks the SDK without them, so the shapes used here are declared
// below and checked against the real typings in typings.check.ts (part of `npm run typecheck`).

/** Planar float samples, as every decoder hands them out. */
export interface Decoded {
  channelData: Float32Array[]
  samplesDecoded: number
  sampleRate: number
}

export interface WasmDecoder {
  ready: Promise<void>
  decode(data: Uint8Array): Decoded | Promise<Decoded>
  flush?: () => Promise<Decoded>
  free(): void | Promise<void>
}

export interface RtcAudioFrame {
  data: Int16Array
  sampleRate: number
  channels: number
  samplesPerChannel: number
}

export interface RtcAudioSource {
  captureFrame(frame: RtcAudioFrame): Promise<void>
  clearQueue(): void
  waitForPlayout(): Promise<void>
  close(): Promise<void>
}

export interface RtcResampler {
  push(frame: RtcAudioFrame): RtcAudioFrame[]
  flush(): RtcAudioFrame[]
  close(): void
}

export interface RtcPublication {
  sid: string | undefined
}

export interface RtcLocalParticipant {
  publishTrack(track: unknown, options: unknown): Promise<RtcPublication>
  unpublishTrack(trackSid: string, stopOnUnpublish?: boolean): Promise<void>
}

export interface RtcRoom {
  localParticipant?: RtcLocalParticipant
  readonly isConnected: boolean
  connect(url: string, token: string, opts?: { autoSubscribe: boolean; dynacast: boolean }): Promise<void>
  disconnect(): Promise<void>
  on(event: 'disconnected', listener: (reason: number) => void): unknown
  on(event: 'localTrackUnpublished', listener: (publication: RtcPublication) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
}

export interface Rtc {
  Room: new () => RtcRoom
  AudioSource: new (sampleRate: number, numChannels: number, queueSizeMs?: number) => RtcAudioSource
  AudioFrame: new (data: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number) => RtcAudioFrame
  AudioResampler: new (inputRate: number, outputRate: number, channels?: number, quality?: number) => RtcResampler
  LocalAudioTrack: { createAudioTrack(name: string, source: RtcAudioSource): { close(closeSource?: boolean): Promise<void> } }
  TrackPublishOptions: new (data: { source: number; dtx: boolean; red: boolean; audioEncoding: { maxBitrate: bigint } }) => unknown
  TrackSource: { SOURCE_MICROPHONE: number }
  DisconnectReason: { PARTICIPANT_REMOVED: number; ROOM_DELETED: number; CLIENT_INITIATED: number }
  AudioResamplerQuality: { HIGH: number }
}

// A specifier in a variable keeps bundlers and the web client's type-check from resolving these packages.
const load = (name: string): Promise<Record<string, unknown>> => import(name)

const missing = (what: string, e: unknown) =>
  new Error(`Voice needs ${what}: run "npm install" in the bots folder (with the iskra-bots package: in your bot's folder; it's an optional dependency). (${(e as Error).message})`)

let rtc: Promise<Rtc> | null = null

/** The LiveKit SDK for Node (native, prebuilt for Windows, macOS and Linux). */
export function loadRtc(): Promise<Rtc> {
  if (rtc) return rtc
  // Its logger prints debug lines unless NODE_ENV is "production" when it loads; a bot's log is for the bot.
  const env = process.env.NODE_ENV
  if (env === undefined) process.env.NODE_ENV = 'production'
  rtc = load('@livekit/rtc-node').then((m) => m as unknown as Rtc, (e) => {
    rtc = null
    throw missing('@livekit/rtc-node', e)
  }).finally(() => {
    if (env === undefined) delete process.env.NODE_ENV
  })
  return rtc
}

export type Codec = 'mp3' | 'opus' | 'vorbis' | 'flac'

const decoders: Record<Codec, { pkg: string; name: string }> = {
  mp3: { pkg: 'mpg123-decoder', name: 'MPEGDecoder' },
  opus: { pkg: 'ogg-opus-decoder', name: 'OggOpusDecoder' },
  vorbis: { pkg: '@wasm-audio-decoders/ogg-vorbis', name: 'OggVorbisDecoder' },
  flac: { pkg: '@wasm-audio-decoders/flac', name: 'FLACDecoder' },
}

/** A fresh streaming decoder (WebAssembly builds of mpg123, libopus, libvorbis and libFLAC). */
export async function loadDecoder(codec: Codec): Promise<WasmDecoder> {
  const { pkg, name } = decoders[codec]
  let module: Record<string, unknown>
  try {
    module = await load(pkg)
  } catch (e) {
    throw missing(pkg, e)
  }
  const Decoder = module[name] as new (options?: object) => WasmDecoder
  const decoder = codec === 'opus' ? new Decoder({ forceStereo: true }) : new Decoder()
  await decoder.ready
  return decoder
}
