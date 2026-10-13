// Audio for voice bots: recognizing a format from its first bytes, streaming decoders (WAV here, the rest in
// WebAssembly), and turning decoded audio into the 10 ms stereo frames LiveKit takes. No native code in this file.
import { loadDecoder, type Decoded, type WasmDecoder } from './modules'

export type Format = 'wav' | 'mp3' | 'opus' | 'vorbis' | 'flac'

/** What LiveKit gets: 48 kHz stereo, 10 ms per frame. */
export const RATE = 48_000
export const CHANNELS = 2
export const FRAME = RATE / 100

/** Enough of the start of a file to tell what it is. */
export const SNIFF_BYTES = 64

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0))

const find = (bytes: Uint8Array, text: string) => {
  for (let i = 0; i + text.length <= bytes.length; i++) if (ascii(bytes, i, text)) return true
  return false
}

/** The format from the first bytes (never from a name or a server's word for it). */
export function sniff(head: Uint8Array): Format | { unsupported: string } {
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return 'wav'
  if (ascii(head, 0, 'fLaC')) return 'flac'
  if (ascii(head, 0, 'OggS')) {
    if (find(head, 'OpusHead')) return 'opus'
    if (find(head, '\x01vorbis')) return 'vorbis'
    return { unsupported: 'this kind of Ogg file' }
  }
  if (ascii(head, 0, 'ID3')) return 'mp3'
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return (head[1] & 0x06) === 0 ? { unsupported: 'AAC' } : 'mp3'
  if (ascii(head, 4, 'ftyp')) return { unsupported: 'MP4/M4A (AAC)' }
  if (head[0] === 0x3c || ascii(head, 0, '\xef\xbb\xbf<')) return { unsupported: 'a web page (not an audio file or stream)' }
  return { unsupported: 'this format' }
}

export const FORMATS = 'MP3, Ogg Opus, Ogg Vorbis, FLAC or WAV'

/** A streaming decoder: bytes in, planar float audio out. */
export interface Decoder {
  push(chunk: Uint8Array): Promise<Decoded[]>
  end(): Promise<Decoded[]>
  free(): void
}

export async function createDecoder(format: Format): Promise<Decoder> {
  if (format === 'wav') return new WavDecoder()
  const wasm = await loadDecoder(format)
  return wrap(wasm)
}

function wrap(wasm: WasmDecoder): Decoder {
  const some = (d: Decoded) => (d.samplesDecoded > 0 ? [d] : [])
  return {
    push: async (chunk) => some(await wasm.decode(chunk)),
    end: async () => (wasm.flush ? some(await wasm.flush()) : []),
    free: () => void wasm.free(),
  }
}

/** RIFF/WAVE: PCM (8, 16, 24 or 32 bit) or 32-bit float, any rate and channel count, streamed. */
export class WavDecoder implements Decoder {
  private pending: Uint8Array = new Uint8Array(0)
  private format: { channels: number; rate: number; bits: number; float: boolean } | null = null
  /** Bytes of sample data still expected (Infinity for streams that don't say). */
  private left = 0
  private inData = false

  async push(chunk: Uint8Array): Promise<Decoded[]> {
    this.pending = concat(this.pending, chunk)
    if (!this.inData && !this.readHeader()) return []
    return this.samples()
  }

  async end(): Promise<Decoded[]> {
    if (!this.inData) throw new Error('That WAV file has no audio in it.')
    return []
  }

  free(): void {
    this.pending = new Uint8Array(0)
  }

  /** Walks the chunks up to "data". False while more bytes are needed. */
  private readHeader(): boolean {
    const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength)
    let at = 12
    while (at + 8 <= this.pending.length) {
      const id = String.fromCharCode(...this.pending.subarray(at, at + 4))
      const size = view.getUint32(at + 4, true)
      if (id === 'data') {
        if (!this.format) throw new Error('That WAV file has no format chunk.')
        this.left = size === 0 || size === 0xffffffff ? Infinity : size
        this.pending = this.pending.slice(at + 8)
        this.inData = true
        return true
      }
      if (at + 8 + size > this.pending.length) return false
      if (id === 'fmt ') {
        let tag = view.getUint16(at + 8, true)
        const channels = view.getUint16(at + 10, true)
        const rate = view.getUint32(at + 12, true)
        const bits = view.getUint16(at + 22, true)
        if (tag === 0xfffe && size >= 26) tag = view.getUint16(at + 32, true) // WAVE_FORMAT_EXTENSIBLE: the sub-format
        const float = tag === 3
        if (!(tag === 1 && [8, 16, 24, 32].includes(bits)) && !(float && bits === 32))
          throw new Error('Only PCM (8, 16, 24 or 32 bit) and 32-bit float WAV files can be played.')
        if (channels < 1 || channels > 8 || rate < 8000 || rate > 384_000) throw new Error('That WAV file has an unusual format.')
        this.format = { channels, rate, bits, float }
      }
      at += 8 + size + (size & 1)
    }
    return false
  }

  private samples(): Decoded[] {
    const f = this.format!
    const frameBytes = (f.bits / 8) * f.channels
    const usable = Math.min(this.pending.length, this.left)
    const frames = Math.floor(usable / frameBytes)
    if (frames === 0) return []
    const bytes = this.pending.subarray(0, frames * frameBytes)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const channelData = Array.from({ length: f.channels }, () => new Float32Array(frames))
    const step = f.bits / 8
    for (let i = 0, at = 0; i < frames; i++) {
      for (let c = 0; c < f.channels; c++, at += step) {
        channelData[c][i] = f.float ? view.getFloat32(at, true)
          : f.bits === 8 ? (view.getUint8(at) - 128) / 128
          : f.bits === 16 ? view.getInt16(at, true) / 32768
          : f.bits === 24 ? ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608)
          : view.getInt32(at, true) / 2147483648
      }
    }
    this.left -= bytes.length
    this.pending = this.pending.slice(bytes.length)
    return [{ channelData, samplesDecoded: frames, sampleRate: f.rate }]
  }
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** Planar float (any channel count) → interleaved 16-bit stereo: mono is copied to both sides, more than two are mixed down. */
export function toStereo(d: Decoded): Int16Array {
  const n = d.samplesDecoded
  const out = new Int16Array(n * 2)
  const [first, second] = d.channelData
  const extra = d.channelData.slice(2)
  for (let i = 0; i < n; i++) {
    let l = first[i]
    let r = second ? second[i] : l
    if (extra.length) {
      // Surround: the rest go into both sides at half level, then everything is scaled back.
      let rest = 0
      for (const ch of extra) rest += ch[i]
      const scale = 1 / (1 + extra.length / 2)
      l = (l + rest / 2) * scale
      r = (r + rest / 2) * scale
    }
    out[2 * i] = clamp16(l * 32767)
    out[2 * i + 1] = clamp16(r * 32767)
  }
  return out
}

const clamp16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v))

/** Volume in place: 0 is silence, 1 as recorded, up to 2. */
export function applyVolume(samples: Int16Array, volume: number): void {
  if (volume === 1) return
  for (let i = 0; i < samples.length; i++) samples[i] = clamp16(samples[i] * volume)
}

/** Cuts interleaved stereo into frames of exactly 10 ms. */
export class Framer {
  private buffer = new Int16Array(FRAME * CHANNELS * 4)
  private length = 0

  push(samples: Int16Array): Int16Array[] {
    if (this.length + samples.length > this.buffer.length) {
      const bigger = new Int16Array((this.length + samples.length) * 2)
      bigger.set(this.buffer.subarray(0, this.length))
      this.buffer = bigger
    }
    this.buffer.set(samples, this.length)
    this.length += samples.length
    const frames: Int16Array[] = []
    const size = FRAME * CHANNELS
    let at = 0
    for (; at + size <= this.length; at += size) frames.push(this.buffer.slice(at, at + size))
    this.buffer.copyWithin(0, at, this.length)
    this.length -= at
    return frames
  }

  /** What's left, padded with silence to a whole frame. */
  flush(): Int16Array[] {
    if (this.length === 0) return []
    const last = new Int16Array(FRAME * CHANNELS)
    last.set(this.buffer.subarray(0, this.length))
    this.length = 0
    return [last]
  }
}

/** Peak level in dBFS of interleaved 16-bit samples (-Infinity for silence); for tests and meters. */
export function peakDb(samples: Int16Array): number {
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  return 20 * Math.log10(peak / 32768)
}

/** 16-bit PCM WAV bytes from planar float samples (-1..1): for audio a bot makes itself (a tone, speech it synthesized). */
export function encodeWav(channelData: Float32Array[], sampleRate: number): Uint8Array {
  const channels = channelData.length
  const frames = channelData[0]?.length ?? 0
  const bytes = new Uint8Array(44 + frames * channels * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, frames * channels * 2, true)
  for (let i = 0, at = 44; i < frames; i++)
    for (let c = 0; c < channels; c++, at += 2) view.setInt16(at, clamp16(channelData[c][i] * 32767), true)
  return bytes
}
