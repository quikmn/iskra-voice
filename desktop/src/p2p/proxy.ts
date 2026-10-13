// PROXY protocol v2 (HAProxy): the header the host's tunnel puts in front of every forwarded connection, so the
// server knows the friend's address (the tunnel listener reads it: server/src/Iskra.Server/Hosting/TunnelListener.cs).
import { isIPv4, isIPv6 } from 'node:net'

const SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a])

export interface Endpoint {
  address: string
  port: number
}

function ipBytes(address: string): Buffer {
  if (isIPv4(address)) return Buffer.from(address.split('.').map(Number))
  const words = expandIPv6(address)
  const out = Buffer.alloc(16)
  words.forEach((w, i) => out.writeUInt16BE(w, i * 2))
  return out
}

function expandIPv6(address: string): number[] {
  // Any IPv4-mapped tail is folded into two words first.
  const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped) {
    const b = mapped[2].split('.').map(Number)
    address = `${mapped[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`
  }
  const [head, tail = ''] = address.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const fill = Array.from({ length: 8 - left.length - right.length }, () => '0')
  return [...left, ...fill, ...right].map((w) => parseInt(w || '0', 16))
}

/**
 * The header for a TCP connection from `source` to `destination`: both must be the same address family (an unknown
 * or odd source is written as 0.0.0.0:0, which the server then treats like any other remote address).
 */
export function proxyV2Header(source: Endpoint | null, destination: Endpoint): Buffer {
  let src = source && (isIPv4(source.address) || isIPv6(source.address)) ? source : { address: '0.0.0.0', port: 0 }
  let dst = destination
  const v6 = isIPv6(src.address) || isIPv6(dst.address)
  if (v6) {
    if (isIPv4(src.address)) src = { ...src, address: `::ffff:${src.address}` }
    if (isIPv4(dst.address)) dst = { ...dst, address: `::ffff:${dst.address}` }
  }
  const addresses = Buffer.concat([ipBytes(src.address), ipBytes(dst.address), Buffer.from([src.port >> 8, src.port & 0xff, dst.port >> 8, dst.port & 0xff])])
  const head = Buffer.alloc(4)
  head[0] = 0x21 // version 2, command PROXY
  head[1] = v6 ? 0x21 : 0x11 // AF_INET6 or AF_INET, STREAM
  head.writeUInt16BE(addresses.length, 2)
  return Buffer.concat([SIGNATURE, head, addresses])
}
