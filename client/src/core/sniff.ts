// What a file really is, from its first bytes: the same rules the server uses for channel uploads (FileSniffer.cs).
// Decrypted DM attachments are shown inline only when their bytes are one of these types; the sender's claimed type
// is never trusted.

export interface Sniffed {
  type: string
  inline: boolean
}

const starts = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

export function sniff(head: Uint8Array): Sniffed {
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: 'image/png', inline: true }
  if (starts(head, ascii('GIF87a')) || starts(head, ascii('GIF89a'))) return { type: 'image/gif', inline: true }
  if (starts(head, ascii('RIFF')) && starts(head, ascii('WEBP'), 8)) return { type: 'image/webp', inline: true }
  if (starts(head, ascii('RIFF')) && starts(head, ascii('WAVE'), 8)) return { type: 'audio/wav', inline: true }
  if (starts(head, [0xff, 0xd8, 0xff])) return { type: 'image/jpeg', inline: true }
  if (head.length >= 12 && starts(head, ascii('ftyp'), 4)) return { type: 'video/mp4', inline: true }
  if (starts(head, [0x1a, 0x45, 0xdf, 0xa3])) return { type: 'video/webm', inline: true }
  if (starts(head, ascii('OggS'))) return { type: 'audio/ogg', inline: true }
  if (starts(head, ascii('ID3')) || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return { type: 'audio/mpeg', inline: true }
  return { type: 'application/octet-stream', inline: false }
}
