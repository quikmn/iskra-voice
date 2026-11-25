// A zip written a file at a time, stored (not compressed: photos and videos already are), for "Download album" in an
// encrypted photos channel, where only this device can read the files. Names are UTF-8. Archives past 4 GB or 65 535
// files get the ZIP64 records; a single file must be under 4 GB.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

const MAX32 = 0xffffffff

/** "IMG_1.jpg", then "IMG_1 (2).jpg" for the next file of that name (the server's zips name files the same way). */
export function uniqueName(used: Set<string>, name: string): string {
  const key = (n: string) => n.toLowerCase()
  if (!used.has(key(name))) {
    used.add(key(name))
    return name
  }
  const dot = name.lastIndexOf('.')
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${extension}`
    if (!used.has(key(candidate))) {
      used.add(key(candidate))
      return candidate
    }
  }
}

/** A date as MS-DOS time and date (local time, 2-second steps, 1980 at the earliest). */
function dosTime(date: Date): { time: number; day: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

interface Entry {
  name: Uint8Array
  crc: number
  size: number
  offset: number
  time: number
  day: number
}

export class ZipWriter {
  private readonly entries: Entry[] = []
  private readonly used = new Set<string>()
  private offset = 0
  private readonly write: (bytes: Uint8Array) => Promise<void>

  /** `write` receives the archive's bytes in order. */
  constructor(write: (bytes: Uint8Array) => Promise<void>) {
    this.write = write
  }

  private async put(bytes: Uint8Array): Promise<void> {
    await this.write(bytes)
    this.offset += bytes.length
  }

  /** Adds one file. Returns the name it got in the archive. */
  async add(name: string, data: Uint8Array, modified: Date): Promise<string> {
    if (data.length >= MAX32) throw new RangeError('A file in a zip must be under 4 GB.')
    const unique = uniqueName(this.used, name.replace(/[\\/]/g, '_') || 'file')
    const encoded = new TextEncoder().encode(unique)
    const { time, day } = dosTime(modified)
    const entry: Entry = { name: encoded, crc: crc32(data), size: data.length, offset: this.offset, time, day }
    const header = new Uint8Array(30 + encoded.length)
    const v = new DataView(header.buffer)
    v.setUint32(0, 0x04034b50, true)
    v.setUint16(4, 20, true) // version needed
    v.setUint16(6, 0x0800, true) // UTF-8 names
    v.setUint16(8, 0, true) // stored
    v.setUint16(10, time, true)
    v.setUint16(12, day, true)
    v.setUint32(14, entry.crc, true)
    v.setUint32(18, entry.size, true)
    v.setUint32(22, entry.size, true)
    v.setUint16(26, encoded.length, true)
    v.setUint16(28, 0, true)
    header.set(encoded, 30)
    await this.put(header)
    await this.put(data)
    this.entries.push(entry)
    return unique
  }

  /** Writes the directory. Nothing can be added after this. */
  async finish(): Promise<void> {
    const start = this.offset
    for (const e of this.entries) {
      const far = e.offset >= MAX32
      const extra = far ? 12 : 0
      const record = new Uint8Array(46 + e.name.length + extra)
      const v = new DataView(record.buffer)
      v.setUint32(0, 0x02014b50, true)
      v.setUint16(4, far ? 45 : 20, true) // made by
      v.setUint16(6, far ? 45 : 20, true) // needed
      v.setUint16(8, 0x0800, true)
      v.setUint16(10, 0, true)
      v.setUint16(12, e.time, true)
      v.setUint16(14, e.day, true)
      v.setUint32(16, e.crc, true)
      v.setUint32(20, e.size, true)
      v.setUint32(24, e.size, true)
      v.setUint16(28, e.name.length, true)
      v.setUint16(30, extra, true)
      v.setUint32(42, far ? MAX32 : e.offset, true)
      record.set(e.name, 46)
      if (far) {
        const x = 46 + e.name.length
        v.setUint16(x, 0x0001, true)
        v.setUint16(x + 2, 8, true)
        v.setBigUint64(x + 4, BigInt(e.offset), true)
      }
      await this.put(record)
    }
    const size = this.offset - start
    const count = this.entries.length
    if (count >= 0xffff || start >= MAX32 || size >= MAX32) {
      const end64 = this.offset
      const record = new Uint8Array(56 + 20)
      const v = new DataView(record.buffer)
      v.setUint32(0, 0x06064b50, true)
      v.setBigUint64(4, 44n, true)
      v.setUint16(12, 45, true)
      v.setUint16(14, 45, true)
      v.setBigUint64(24, BigInt(count), true)
      v.setBigUint64(32, BigInt(count), true)
      v.setBigUint64(40, BigInt(size), true)
      v.setBigUint64(48, BigInt(start), true)
      v.setUint32(56, 0x07064b50, true) // the locator
      v.setBigUint64(64, BigInt(end64), true)
      v.setUint32(72, 1, true)
      await this.put(record)
    }
    const end = new Uint8Array(22)
    const v = new DataView(end.buffer)
    v.setUint32(0, 0x06054b50, true)
    v.setUint16(8, Math.min(count, 0xffff), true)
    v.setUint16(10, Math.min(count, 0xffff), true)
    v.setUint32(12, Math.min(size, MAX32), true)
    v.setUint32(16, Math.min(start, MAX32), true)
    await this.put(end)
  }
}
