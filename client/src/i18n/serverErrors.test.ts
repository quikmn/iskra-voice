// The server names its error messages with a key (PROTOCOL.md → Errors). Every key it can send must have a text in
// every language, and the English text must say what the server says.
import { describe, expect, it } from 'vitest'
import { en } from './en'
import { sv } from './sv'
import { i18next } from '.'
import { errorMessage, translatedServerMessage } from './errors'
import { RequestError } from '../core/protocol'

/** The server's C# sources (bundled by Vite for the test). */
const SOURCES = Object.values(import.meta.glob('../../../server/src/Iskra.Server/**/*.cs', { query: '?raw', import: 'default', eager: true })) as string[]

/** Keys built from a variable, with every value the server passes. */
const DYNAMIC: Record<string, string[]> = {
  'blocked_{what}': ['blocked_call', 'blocked_message'],
  'owner_security_{what}': ['owner_security_read', 'owner_security_change'],
}

// `"message", "key"` or `$"message {x}", "key", new { ... }` inside a RequestException.
const CALL = /RequestException(?:\.\w+|\("\w+",)\(?\s*(\$?)"((?:[^"\\]|\\.)*)",\s*(\$?)"([a-z0-9_{}]+)"/g
const found = SOURCES.flatMap((source) => [...source.matchAll(CALL)].map((m) => ({ interpolated: !!m[1], message: m[2], key: m[4] })))
const keys = new Set(found.flatMap(({ key }) => DYNAMIC[key] ?? [key]))
const PLACEHOLDERS = /\{\{?[^{}]+\}?\}/g

describe('server error keys', () => {
  it('are found in the server sources', () => {
    expect(keys.size).toBeGreaterThan(200)
    for (const key of ['timed_out', 'channel_name', 'slowmode', 'upload_quota', 'channel_full']) expect(keys).toContain(key)
  })

  it('all have English and Swedish texts', () => {
    const missing = [...keys].filter((key) => !(key in en.errors.server) || !(key in sv.errors.server))
    // AutoMod's keys come from the rule that matched.
    for (const rule of ['words', 'mentions', 'invites', 'links', 'flood', 'duplicates']) {
      if (!(`automod_${rule}` in en.errors.server)) missing.push(`automod_${rule}`)
    }
    expect(missing).toEqual([])
  })

  it("don't look like plural forms", () => {
    expect([...keys].filter((key) => /_(zero|one|two|few|many|other)$/.test(key))).toEqual([])
  })

  it('say in English what the server says', () => {
    const texts = en.errors.server as Record<string, string>
    const differ = found
      .filter(({ key }) => !DYNAMIC[key] && texts[key] !== undefined)
      .filter(({ message, key }) => message.replace(/\\"/g, '"').replace(PLACEHOLDERS, '{}') !== texts[key].replace(PLACEHOLDERS, '{}'))
      .map(({ key, message }) => `${key}: ${message}`)
    expect(differ).toEqual([])
  })

  it('show in Swedish with their values', async () => {
    await i18next.changeLanguage('sv')
    try {
      expect(errorMessage(new RequestError('bad_request', 'Channel names must be 1–32 characters.', 'channel.create', 'channel_name', { max: 32 })))
        .toBe('Kanalnamn måste vara 1–32 tecken.')
      expect(translatedServerMessage('slowmode', { seconds: 150 })).toBe('Långsamt läge är på. Du kan skicka igen om 3 minuter.')
      expect(translatedServerMessage('automod_flood', { max: 5, timeoutMs: 300_000 }))
        .toBe('Stoppat av AutoMod: du skickar meddelanden för snabbt. Du har fått timeout i 5 minuter.')
      expect(translatedServerMessage('automod_links', { max: 5, timeoutMs: 0 })).toBe('Stoppat av AutoMod: länkar är inte tillåtna här.')
      // An unknown key falls back to the code, then the server's text.
      expect(errorMessage(new RequestError('forbidden', 'Something new.', 'x.y', 'brand_new_key'))).toBe('Du har inte behörighet att göra det.')
      expect(errorMessage(new RequestError('bad_request', 'Something new.', 'x.y', 'brand_new_key'))).toBe('Something new.')
    } finally {
      await i18next.changeLanguage('en')
    }
    expect(errorMessage(new RequestError('bad_request', 'Channel names must be 1–32 characters.', 'channel.create', 'channel_name', { max: 32 })))
      .toBe('Channel names must be 1–32 characters.')
  })
})
