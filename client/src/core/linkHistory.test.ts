import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, ready } from './crypto'
import { ephemeralKey, openPart, sealPart, splitParts } from './link'

beforeAll(ready)

describe('history parts', () => {
  it('split, seal and come back together only for the right device, in order', () => {
    const existing = ephemeralKey()
    const fresh = ephemeralKey()
    const other = ephemeralKey()
    const bytes = randomBytes(10_000)
    const parts = splitParts(bytes, 4096)
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808])
    const sealed = parts.map((p, i) => sealPart(i, parts.length, p, existing, fresh.publicKey))

    const opened = sealed.map((s, i) => openPart(s, i, parts.length, existing.publicKey, fresh))
    expect(new Uint8Array(opened.flatMap((p) => [...p]))).toEqual(bytes)

    // Swapped, recounted, or opened by anyone else: refused.
    expect(() => openPart(sealed[1], 0, parts.length, existing.publicKey, fresh)).toThrow(/order/)
    expect(() => openPart(sealed[2], 2, 2, existing.publicKey, fresh)).toThrow(/order/)
    expect(() => openPart(sealed[0], 0, parts.length, existing.publicKey, other)).toThrow()
    const tampered = sealed[0].slice()
    tampered[40] ^= 1
    expect(() => openPart(tampered, 0, parts.length, existing.publicKey, fresh)).toThrow()
  })

  it('an empty history is still one part', () => {
    expect(splitParts(new Uint8Array())).toHaveLength(1)
  })
})
