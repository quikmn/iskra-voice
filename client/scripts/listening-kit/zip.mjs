// A plain zip file (deflate, or stored where deflate doesn't help), for packing the kit.
import { crc32, deflateRawSync } from 'node:zlib'

/** `files`: [name inside the zip, bytes]. Returns the zip's bytes. */
export function zip(files) {
  const parts = []
  const central = []
  let offset = 0
  const time = new Date()
  const dosTime = (time.getHours() << 11) | (time.getMinutes() << 5) | (time.getSeconds() >> 1)
  const dosDate = ((time.getFullYear() - 1980) << 9) | ((time.getMonth() + 1) << 5) | time.getDate()
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const deflated = deflateRawSync(data, { level: 9 })
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // UTF-8 names
    head.writeUInt16LE(stored ? 0 : 8, 8)
    head.writeUInt16LE(dosTime, 10)
    head.writeUInt16LE(dosDate, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBytes.length, 26)
    parts.push(head, nameBytes, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(stored ? 0 : 8, 10)
    entry.writeUInt16LE(dosTime, 12)
    entry.writeUInt16LE(dosDate, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += head.length + nameBytes.length + body.length
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, ...central, end])
}
