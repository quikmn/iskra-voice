// FLAC (lossless) for the listening page: 16-bit mono at 48 kHz, fixed predictors (orders 0-4) and Rice-coded
// residuals, per the format spec (RFC 9639). Browsers decode it natively (decodeAudioData); about half the size of
// the WAV, bit for bit the same samples. The kit's test checks it against ffmpeg when that's installed.

const BLOCK = 4096

class Bits {
  constructor(bytes) {
    this.buf = new Uint8Array(bytes)
    this.pos = 0
    this.acc = 0
    this.n = 0
  }
  grow(more) {
    if (this.pos + more + 8 <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + more + 1024))
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }
  /** Writes the low `bits` bits of `value` (unsigned), most significant first. */
  write(value, bits) {
    if (bits > 24) {
      this.write(Math.floor(value / 0x1000000) & ((1 << (bits - 24)) - 1), bits - 24)
      this.write(value & 0xffffff, 24)
      return
    }
    this.grow(4)
    this.acc = ((this.acc << bits) | (value & ((1 << bits) - 1))) >>> 0
    this.n += bits
    while (this.n >= 8) {
      this.n -= 8
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff
    }
    this.acc &= (1 << this.n) - 1
  }
  signed(value, bits) {
    this.write(value < 0 ? value + 2 ** bits : value, bits)
  }
  /** `q` zeros, then a one. */
  unary(q) {
    while (q >= 24) {
      this.write(0, 24)
      q -= 24
    }
    this.write(1, q + 1)
  }
  align() {
    if (this.n) this.write(0, 8 - this.n)
  }
  bytes() {
    return this.buf.subarray(0, this.pos)
  }
}

const CRC8 = new Uint8Array(256)
const CRC16 = new Uint16Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff
  CRC8[i] = c
  let d = i << 8
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff
  CRC16[i] = d
}
const crc8 = (b) => b.reduce((c, x) => CRC8[c ^ x], 0)
const crc16 = (b) => b.reduce((c, x) => ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ x], 0)

/** Residuals of the fixed predictor of this order (from sample `order` on). */
function residual(x, order) {
  const n = x.length
  const r = new Int32Array(n - order)
  for (let i = order; i < n; i++) {
    let p = 0
    if (order === 1) p = x[i - 1]
    else if (order === 2) p = 2 * x[i - 1] - x[i - 2]
    else if (order === 3) p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]
    else if (order === 4) p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4]
    r[i - order] = x[i] - p
  }
  return r
}

const zigzag = (v) => (v >= 0 ? 2 * v : -2 * v - 1)

/** The best Rice parameter (0-14) for `len` zigzagged residuals summing to `sum`, and about what it costs in bits. */
function rice(len, sum) {
  let best = 0
  let bestBits = Infinity
  for (let k = 0; k <= 14; k++) {
    const bits = len * (k + 1) + Math.max(0, sum / 2 ** k - len / 2)
    if (bits < bestBits) {
      bestBits = bits
      best = k
    }
  }
  return { k: best, bits: bestBits }
}

/** The cheapest partitioning of the residual: partition order, each partition's parameter, about how many bits. */
function plan(r, order, n) {
  const u = new Uint32Array(r.length)
  for (let i = 0; i < r.length; i++) u[i] = zigzag(r[i])
  let maxP = 0
  while (maxP < 8 && n % (1 << (maxP + 1)) === 0 && n >> (maxP + 1) > order) maxP++
  if (n >> maxP <= order) return null
  // Sums per partition at the finest order, then merged pairwise for each coarser one.
  let size = n >> maxP
  let sums = new Float64Array(1 << maxP)
  let lens = new Float64Array(1 << maxP)
  for (let j = 0; j < sums.length; j++) {
    const from = j === 0 ? 0 : j * size - order
    const to = (j + 1) * size - order
    let s = 0
    for (let i = from; i < to; i++) s += u[i]
    sums[j] = s
    lens[j] = to - from
  }
  let best = null
  for (let p = maxP; p >= 0; p--) {
    const params = []
    let bits = 6
    for (let j = 0; j < sums.length; j++) {
      const { k, bits: b } = rice(lens[j], sums[j])
      params.push(k)
      bits += 4 + b
    }
    if (!best || bits < best.bits) best = { p, params, bits, u }
    if (p === 0) break
    const s2 = new Float64Array(sums.length / 2)
    const l2 = new Float64Array(sums.length / 2)
    for (let j = 0; j < s2.length; j++) {
      s2[j] = sums[2 * j] + sums[2 * j + 1]
      l2[j] = lens[2 * j] + lens[2 * j + 1]
    }
    sums = s2
    lens = l2
    size *= 2
  }
  return best
}

function subframe(out, x) {
  if (x.every((v) => v === x[0])) {
    out.write(0, 8) // CONSTANT
    out.signed(x[0], 16)
    return
  }
  let best = null
  for (let order = 0; order <= 4 && order < x.length; order++) {
    const pl = plan(residual(x, order), order, x.length)
    if (pl && (!best || order * 16 + pl.bits < best.order * 16 + best.bits)) best = { ...pl, order }
  }
  if (!best || best.order * 16 + best.bits >= x.length * 16) {
    out.write(0b00000010, 8) // VERBATIM
    for (const v of x) out.signed(v, 16)
    return
  }
  out.write((0b001000 | best.order) << 1, 8) // FIXED
  for (let i = 0; i < best.order; i++) out.signed(x[i], 16)
  out.write(0, 2) // Rice, 4-bit parameters
  out.write(best.p, 4)
  const size = x.length >> best.p
  for (let j = 0; j < best.params.length; j++) {
    const k = best.params[j]
    out.write(k, 4)
    const from = j === 0 ? 0 : j * size - best.order
    const to = (j + 1) * size - best.order
    for (let i = from; i < to; i++) {
      const v = best.u[i]
      out.unary(v >>> k)
      if (k) out.write(v & ((1 << k) - 1), k)
    }
  }
}

function utf8(n) {
  if (n < 0x80) return [n]
  if (n < 0x800) return [0xc0 | (n >> 6), 0x80 | (n & 0x3f)]
  if (n < 0x10000) return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)]
  return [0xf0 | (n >> 18), 0x80 | ((n >> 12) & 0x3f), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)]
}

/** 16-bit samples (Int16Array) at 48 kHz, mono, as FLAC file bytes. */
export function encodeFlac(samples, rate = 48000) {
  if (rate !== 48000) throw new Error('48 kHz only')
  const out = new Bits(samples.length * 2 + 4096)
  for (const c of 'fLaC') out.write(c.charCodeAt(0), 8)
  out.write(0x80, 8) // last metadata block, STREAMINFO
  out.write(34, 24)
  out.write(BLOCK, 16)
  out.write(BLOCK, 16)
  out.write(0, 24)
  out.write(0, 24)
  out.write(rate, 20)
  out.write(0, 3) // one channel
  out.write(15, 5) // 16 bits
  out.write(samples.length, 36)
  for (let i = 0; i < 16; i++) out.write(0, 8) // no MD5
  let frame = 0
  for (let at = 0; at < samples.length; at += BLOCK, frame++) {
    const x = samples.subarray(at, Math.min(samples.length, at + BLOCK))
    const head = [0xff, 0xf8]
    const n = x.length
    const sizeCode = n === BLOCK ? 0b1100 : n <= 256 ? 0b0110 : 0b0111
    head.push((sizeCode << 4) | 0b1010, 0b00001000, ...utf8(frame))
    if (sizeCode === 0b0110) head.push(n - 1)
    if (sizeCode === 0b0111) head.push((n - 1) >> 8, (n - 1) & 0xff)
    head.push(crc8(head))
    const frameStart = out.pos
    for (const b of head) out.write(b, 8)
    subframe(out, Int32Array.from(x))
    out.align()
    const crc = crc16(out.buf.subarray(frameStart, out.pos))
    out.write(crc, 16)
  }
  return out.bytes().slice()
}
