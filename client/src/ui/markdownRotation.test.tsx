import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { b64u, generateSigningKeyPair, ready } from '../core/crypto'
import { signRotation, type Rotation } from '../core/rotation'

// The rotations this device remembers come from storage; here, one rotation from Alice's old key to her new one.
const remembered: Rotation[] = []
vi.mock('../core/storage', () => ({ loadRotations: async () => remembered, saveRotations: async () => undefined }))

const { decodeMentions, mentions, plainText, renderMarkdown } = await import('./markdown')
const { keysReady } = await import('../state/keyMap')

let oldKey = ''
let newKey = ''
beforeAll(async () => {
  await ready()
  const before = generateSigningKeyPair()
  const after = generateSigningKeyPair()
  remembered.push(signRotation(before, after))
  ;[oldKey, newKey] = [b64u(before.publicKey), b64u(after.publicKey)]
  await keysReady()
})

describe('mentions of an old account key', () => {
  it('show the person under their current key', () => {
    const ctx = { nameOf: (k: string) => (k === newKey ? 'Alice' : null), me: newKey }
    expect(renderToStaticMarkup(<>{renderMarkdown(`hi <@${oldKey}>`, ctx)}</>)).toBe('hi <span class="mention me">@Alice</span>')
    expect(plainText(`hi <@${oldKey}>`, ctx)).toBe('hi @Alice')
    expect(decodeMentions(`<@${oldKey}>`, ctx.nameOf)).toBe('@Alice')
    expect(mentions(`ping <@${oldKey}>`, newKey)).toBe(true)
    expect(mentions(`ping <@${newKey}>`, oldKey)).toBe(false)
  })
})
