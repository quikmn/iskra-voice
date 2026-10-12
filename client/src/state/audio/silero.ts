// Silero VAD (v6, 16 kHz) in plain TypeScript: a tiny network (an STFT as a convolution, four convolutions, one LSTM
// cell) that tells speech from everything else. The model file is bundled with the app.
// Mirrors silero_vad/tinygrad_model.py from the Silero VAD repository (MIT). No WebAssembly, no runtime: ~0.7 M
// multiply-adds per 32 ms frame. The weights are read straight from the official ONNX file. No DOM here: it runs in a worker and in Node (tests, benchmark).

export const SILERO_RATE = 16000
/** Samples per frame at 16 kHz (32 ms). */
export const SILERO_FRAME = 512
const CONTEXT = 64
const N_FFT = 256
const HOP = 128
const BINS = N_FFT / 2 + 1 // 129
const HIDDEN = 128

export interface Tensor {
  shape: number[]
  data: Float32Array
}

/** The model's weights, by the names Silero's ONNX export gives them. */
const NAMES: Record<string, string> = {
  'model.stft.forward_basis_buffer': 'stft',
  'model.encoder.0.reparam_conv.weight': 'c1w', 'model.encoder.0.reparam_conv.bias': 'c1b',
  'model.encoder.1.reparam_conv.weight': 'c2w', 'model.encoder.1.reparam_conv.bias': 'c2b',
  'model.encoder.2.reparam_conv.weight': 'c3w', 'model.encoder.2.reparam_conv.bias': 'c3b',
  'model.encoder.3.reparam_conv.weight': 'c4w', 'model.encoder.3.reparam_conv.bias': 'c4b',
  'model.decoder.rnn.weight_ih': 'wih', 'model.decoder.rnn.weight_hh': 'whh',
  'model.decoder.rnn.bias_ih': 'bih', 'model.decoder.rnn.bias_hh': 'bhh',
  'model.decoder.decoder.2.weight': 'fw', 'model.decoder.decoder.2.bias': 'fb',
}

/**
 * Pulls the float weights out of the official ONNX file (protobuf: ModelProto.graph → GraphProto.initializer →
 * TensorProto with dims, data_type, name and raw_data). Only what this model uses; anything else is skipped.
 */
export function parseOnnxWeights(buffer: ArrayBuffer): Record<string, Tensor> {
  const bytes = new Uint8Array(buffer)
  const out: Record<string, Tensor> = {}
  const varint = (r: { p: number }) => {
    let v = 0
    let shift = 1
    for (;;) {
      if (r.p >= bytes.length) throw new Error('onnx: truncated')
      const b = bytes[r.p++]
      v += (b & 0x7f) * shift
      if (b < 0x80) return v
      shift *= 128
      if (shift > 2 ** 56) throw new Error('onnx: bad varint')
    }
  }
  // Walks the fields of the message in [start, end), calling `on` for each length-delimited one.
  const fields = (start: number, end: number, on: (field: number, from: number, to: number) => void, onVarint?: (field: number, value: number) => void) => {
    const r = { p: start }
    while (r.p < end) {
      const key = varint(r)
      const field = Math.floor(key / 8)
      const wire = key & 7
      if (wire === 0) onVarint?.(field, varint(r))
      else if (wire === 1) r.p += 8
      else if (wire === 5) r.p += 4
      else if (wire === 2) {
        const length = varint(r)
        if (r.p + length > end) throw new Error('onnx: truncated field')
        on(field, r.p, r.p + length)
        r.p += length
      } else throw new Error('onnx: unsupported wire type')
    }
  }
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  fields(0, bytes.length, (field, from, to) => {
    if (field !== 7) return // ModelProto.graph
    fields(from, to, (gfield, gfrom, gto) => {
      if (gfield !== 5) return // GraphProto.initializer
      const dims: number[] = []
      let name = ''
      let type = 0
      let raw = null as [number, number] | null // set in the callback below
      fields(gfrom, gto, (tfield, tfrom, tto) => {
        if (tfield === 8) name = text(tfrom, tto)
        else if (tfield === 9) raw = [tfrom, tto]
        else if (tfield === 1) { // packed dims
          const r = { p: tfrom }
          while (r.p < tto) dims.push(varint(r))
        }
      }, (tfield, value) => {
        if (tfield === 1) dims.push(value)
        else if (tfield === 2) type = value
      })
      const key = NAMES[name]
      if (!key || !raw || type !== 1) return // 1 = FLOAT
      const [rfrom, rto] = raw
      const data = new Float32Array((rto - rfrom) / 4)
      new Uint8Array(data.buffer).set(bytes.subarray(rfrom, rto)) // copied: raw_data isn't aligned
      out[key] = { shape: dims, data }
    })
  })
  return out
}

function need(weights: Record<string, Tensor>, name: string, shape: number[]): Float32Array {
  const t = weights[name]
  if (!t || t.shape.length !== shape.length || t.shape.some((d, i) => d !== shape[i])) throw new Error(`silero: ${name} missing or wrong shape`)
  return t.data
}

/** Conv1d with kernel 3 and padding 1: input [cin][lin], weights [cout][cin][3] → output [cout][lout], then ReLU. */
function conv3relu(input: Float32Array, cin: number, lin: number, w: Float32Array, b: Float32Array, cout: number, stride: number, out: Float32Array): number {
  const lout = Math.floor((lin + 2 - 3) / stride) + 1
  for (let o = 0; o < cout; o++) {
    for (let t = 0; t < lout; t++) {
      let sum = b[o]
      const start = t * stride - 1
      for (let c = 0; c < cin; c++) {
        const wo = (o * cin + c) * 3
        const io = c * lin
        for (let k = 0; k < 3; k++) {
          const x = start + k
          if (x >= 0 && x < lin) sum += w[wo + k] * input[io + x]
        }
      }
      out[o * lout + t] = sum > 0 ? sum : 0
    }
  }
  return lout
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

export class SileroVad {
  private readonly stft: Float32Array
  private readonly c1w: Float32Array; private readonly c1b: Float32Array
  private readonly c2w: Float32Array; private readonly c2b: Float32Array
  private readonly c3w: Float32Array; private readonly c3b: Float32Array
  private readonly c4w: Float32Array; private readonly c4b: Float32Array
  private readonly wih: Float32Array; private readonly whh: Float32Array; private readonly bias: Float32Array
  private readonly fw: Float32Array; private readonly fb: number
  // State and scratch, allocated once.
  private readonly h = new Float32Array(HIDDEN)
  private readonly c = new Float32Array(HIDDEN)
  private readonly padded = new Float32Array(CONTEXT + SILERO_FRAME + CONTEXT)
  private readonly mag = new Float32Array(BINS * 4)
  private readonly a = new Float32Array(128 * 4)
  private readonly b = new Float32Array(128 * 4)
  private readonly gates = new Float32Array(4 * HIDDEN)

  constructor(weights: Record<string, Tensor>) {
    this.stft = need(weights, 'stft', [2 * BINS, 1, N_FFT])
    this.c1w = need(weights, 'c1w', [128, BINS, 3]); this.c1b = need(weights, 'c1b', [128])
    this.c2w = need(weights, 'c2w', [64, 128, 3]); this.c2b = need(weights, 'c2b', [64])
    this.c3w = need(weights, 'c3w', [64, 64, 3]); this.c3b = need(weights, 'c3b', [64])
    this.c4w = need(weights, 'c4w', [128, 64, 3]); this.c4b = need(weights, 'c4b', [128])
    this.wih = need(weights, 'wih', [4 * HIDDEN, HIDDEN])
    this.whh = need(weights, 'whh', [4 * HIDDEN, HIDDEN])
    const bih = need(weights, 'bih', [4 * HIDDEN])
    const bhh = need(weights, 'bhh', [4 * HIDDEN])
    this.bias = bih.map((v, i) => v + bhh[i])
    this.fw = need(weights, 'fw', [1, HIDDEN, 1])
    this.fb = need(weights, 'fb', [1])[0]
  }

  reset(): void {
    this.h.fill(0)
    this.c.fill(0)
    this.padded.fill(0)
  }

  /** Speech probability (0–1) for the next 512 samples at 16 kHz. */
  process(frame: Float32Array): number {
    const p = this.padded
    const n = CONTEXT + SILERO_FRAME // 576
    // [64 samples of context | the frame], then 64 samples of reflection padding on the right.
    p.copyWithin(0, SILERO_FRAME, n)
    p.set(frame.subarray(0, SILERO_FRAME), CONTEXT)
    for (let j = 0; j < CONTEXT; j++) p[n + j] = p[n - 2 - j]

    // STFT as a strided convolution: 258 channels (real, imaginary) × 4 frames, then magnitudes.
    const frames = (p.length - N_FFT) / HOP + 1 // 4
    for (let f = 0; f < BINS; f++) {
      const re = f * N_FFT
      const im = (f + BINS) * N_FFT
      for (let t = 0; t < frames; t++) {
        const off = t * HOP
        let r = 0
        let i = 0
        for (let k = 0; k < N_FFT; k++) {
          const x = p[off + k]
          r += this.stft[re + k] * x
          i += this.stft[im + k] * x
        }
        this.mag[f * frames + t] = Math.sqrt(r * r + i * i)
      }
    }

    let len = conv3relu(this.mag, BINS, frames, this.c1w, this.c1b, 128, 1, this.a)
    len = conv3relu(this.a, 128, len, this.c2w, this.c2b, 64, 2, this.b)
    len = conv3relu(this.b, 64, len, this.c3w, this.c3b, 64, 2, this.a)
    len = conv3relu(this.a, 64, len, this.c4w, this.c4b, 128, 1, this.b) // len is 1 here
    const x = this.b

    // LSTM cell (PyTorch gate order: input, forget, cell, output).
    const g = this.gates
    for (let r = 0; r < 4 * HIDDEN; r++) {
      let sum = this.bias[r]
      const o = r * HIDDEN
      for (let k = 0; k < HIDDEN; k++) sum += this.wih[o + k] * x[k] + this.whh[o + k] * this.h[k]
      g[r] = sum
    }
    let out = this.fb
    for (let k = 0; k < HIDDEN; k++) {
      const i = sigmoid(g[k])
      const f = sigmoid(g[HIDDEN + k])
      const cell = Math.tanh(g[2 * HIDDEN + k])
      const o = sigmoid(g[3 * HIDDEN + k])
      this.c[k] = f * this.c[k] + i * cell
      this.h[k] = o * Math.tanh(this.c[k])
      const relu = this.h[k] > 0 ? this.h[k] : 0
      out += this.fw[k] * relu
    }
    return sigmoid(out)
  }
}
