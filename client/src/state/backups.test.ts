import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, fromB64u, generateSigningKeyPair, ready, signedPayload } from '../core/crypto'
import type { ImportJob } from '../core/protocol'
import { authorOf } from '../ui/chat/bots'
import { formatBytes, importFraction, PASSPHRASE_CONTEXT, passphraseStrength, sealPassphrase } from './backups'

beforeAll(async () => {
  await ready()
})

const job = (patch: Partial<ImportJob>): ImportJob => ({
  phase: 'importing', channels: 2, channelsDone: 0, messages: 200, messagesDone: 50, files: 0, missingFiles: 0, skipped: 0,
  current: null, error: null, warnings: [], imported: [], ...patch,
})

describe('backups and imports', () => {
  it('rates passphrases', () => {
    expect(passphraseStrength('short')).toBe('too-short')
    expect(passphraseStrength('        x')).toBe('too-short')
    expect(passphraseStrength('abcdefgh')).toBe('weak')
    expect(passphraseStrength('abcdefgh1234')).toBe('ok')
    expect(passphraseStrength('correct horse battery staple')).toBe('strong')
  })

  it('seals the passphrase so only that server can read it', () => {
    const server = generateSigningKeyPair()
    const sealed = fromB64u(sealPassphrase(b64u(server.publicKey), 'correct horse'))
    const pk = sodium.crypto_sign_ed25519_pk_to_curve25519(server.publicKey)
    const sk = sodium.crypto_sign_ed25519_sk_to_curve25519(server.secretKey)
    const opened = sodium.crypto_box_seal_open(sealed, pk, sk)
    expect(opened).toEqual(signedPayload(PASSPHRASE_CONTEXT, server.publicKey, new TextEncoder().encode('correct horse')))
    expect(new TextDecoder().decode(sealed)).not.toContain('correct horse')
    // Another key can't open it.
    const other = generateSigningKeyPair()
    expect(() => sodium.crypto_box_seal_open(sealed, sodium.crypto_sign_ed25519_pk_to_curve25519(other.publicKey), sodium.crypto_sign_ed25519_sk_to_curve25519(other.secretKey))).toThrow()
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB')
  })

  it('measures import progress', () => {
    expect(importFraction(job({}))).toBe(0.25)
    expect(importFraction(job({ phase: 'reading' }))).toBeNull()
    expect(importFraction(job({ phase: 'done' }))).toBe(1)
  })

  it('shows imported authors by their Discord name', () => {
    const imported = { source: 'discord' as const, name: 'Annie', avatar: null, bot: false, reactions: [], missingAttachments: [] }
    expect(authorOf({ author: 'discord:1', imported }, {})).toEqual({ name: 'Annie', bot: false, avatar: null })
    expect(authorOf({ author: 'discord:1', imported: { ...imported, bot: true } }, {}).bot).toBe(true)
    expect(authorOf({ author: 'abc' }, {}).name).toBe('Former member')
  })
})
