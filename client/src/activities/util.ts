// Small pure helpers the built-in activities share (no DOM, no SDK): checks for what arrives, text and hashing.

/** "{{name}} won" with values filled in (texts only ever go into textContent). */
export function fmt(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => String(vars[key] ?? ''))
}

/** Same text, compared loosely: case, accents of a/e/i/o/u kept (å, ä, ö are letters in Swedish), extra spaces. */
export function normalizeGuess(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

/** A small, stable hash (FNV-1a, 32 bits) as hex. Keeps answers out of sight; it isn't a secret. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 32
export const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
export const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
