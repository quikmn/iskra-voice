import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, randomBytes, ready } from './crypto'
import {
  checkMac, confirmationCode, encodeLinkCode, sameConfirmation, ephemeralKey, linkAppUrl, linkKeys, macKey, newLinkSecret, openPayload,
  parseLinkCode, sealPayload, type LinkCode,
} from './link'

beforeAll(ready)

const code = (serverUrl = 'https://chat.example.com'): LinkCode => ({ serverUrl, token: b64u(randomBytes(10)), secret: newLinkSecret() })

describe('link codes', () => {
  it('round-trip as text and as an app link', () => {
    const c = code()
    const text = encodeLinkCode(c)
    expect(text).toMatch(/^chat\.example\.com\/([0-9A-Z]{4}-){10}[0-9A-Z]{2}$/)
    expect(parseLinkCode(text)).toEqual(c)
    expect(parseLinkCode(linkAppUrl('https://app.iskra.foo/', c))).toEqual(c)
    // Typed by hand: lower case, spaces instead of dashes, look-alike letters.
    const typed = text.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o')
    expect(parseLinkCode(typed)).toEqual(c)
  })

  it('keep non-https servers explicit', () => {
    const c = code('http://localhost:47070')
    expect(encodeLinkCode(c).startsWith('http://localhost:47070/')).toBe(true)
    expect(parseLinkCode(encodeLinkCode(c))).toEqual(c)
  })

  it('reject garbage and truncated codes', () => {
    const text = encodeLinkCode(code())
    expect(parseLinkCode(text.slice(0, -3))).toBeNull()
    expect(parseLinkCode('hello')).toBeNull()
    expect(parseLinkCode('javascript:alert(1)/' + text.split('/')[1])).toBeNull()
  })
})

describe('the link handshake', () => {
  it('lets both devices agree, and only the new device can open the payload', () => {
    const c = code()
    const existingKeys = linkKeys(c)
    const newKeys = linkKeys(parseLinkCode(encodeLinkCode(c))!)

    const fresh = ephemeralKey()
    const hello = { epk: b64u(fresh.publicKey), mac: macKey(fresh.publicKey, newKeys.macNew) }
    const seen = checkMac(hello.epk, hello.mac, existingKeys.macNew)
    expect(seen).not.toBeNull()

    const existing = ephemeralKey()
    const answer = { epk: b64u(existing.publicKey), mac: macKey(existing.publicKey, existingKeys.macExisting) }
    const answered = checkMac(answer.epk, answer.mac, newKeys.macExisting)!
    expect(answered).not.toBeNull()

    expect(confirmationCode(existingKeys, existing.publicKey, seen!)).toBe(confirmationCode(newKeys, answered, fresh.publicKey))
    expect(confirmationCode(newKeys, answered, fresh.publicKey)).toMatch(/^\d{3} \d{3}$/)

    const sealed = sealPayload({ seed: 'secret stuff' }, existing, seen!)
    expect(openPayload<{ seed: string }>(sealed, answered, fresh).seed).toBe('secret stuff')
    expect(() => openPayload(sealed, answered, ephemeralKey())).toThrow()
  })

  it('checks the typed confirmation number', () => {
    expect(sameConfirmation('042917', '042 917')).toBe(true)
    expect(sameConfirmation(' 042 917 ', '042 917')).toBe(true)
    expect(sameConfirmation('042-917', '042 917')).toBe(true)
    expect(sameConfirmation('042 918', '042 917')).toBe(false)
    expect(sameConfirmation('', '042 917')).toBe(false)
    expect(sameConfirmation('42917', '042 917')).toBe(false)
  })

  it('a server without the secret cannot slip in its own key', () => {
    const c = code()
    const keys = linkKeys(c)
    const mitm = ephemeralKey()
    // The server knows the token but not the secret, so its MAC is made with the wrong key.
    const guessed = linkKeys({ ...c, secret: newLinkSecret() })
    expect(checkMac(b64u(mitm.publicKey), macKey(mitm.publicKey, guessed.macNew), keys.macNew)).toBeNull()
    // A MAC from one side can't be replayed as the other side's.
    const fresh = ephemeralKey()
    expect(checkMac(b64u(fresh.publicKey), macKey(fresh.publicKey, keys.macNew), keys.macExisting)).toBeNull()
  })
})
