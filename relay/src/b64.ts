// Base64 helpers (standard and URL-safe without padding). Workers and Node both have atob/btoa.

export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function toB64u(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Null if it isn't base64 or base64url. */
export function fromB64(text: string): Uint8Array | null {
  const std = text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '').replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]*$/.test(std) || std.length % 4 === 1) return null
  try {
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export const utf8 = new TextEncoder()
