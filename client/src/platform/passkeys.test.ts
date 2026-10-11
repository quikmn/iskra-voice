import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, fromB64u, ready } from '../core/crypto'
import {
  addPasskeySlot, browserWrapper, isLocked, newDataKey, newPasskeySalt, openPasskeySlot, removePasskeySlot, withPassphrase,
  type VaultRecord,
} from '../core/vault'
import { browserCeremonies, createPasskey, getPasskeySecret, PasskeyError } from './passkeys'

beforeAll(ready)

const CHEAP = { opslimit: 1, memlimit: 8192 }
const toBytes = (b: BufferSource) => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength))

/**
 * A software authenticator that does what CTAP2 hmac-secret does for PRF: each credential has its own secret, and
 * the output is HMAC-SHA256(secret, SHA-256("WebAuthn PRF" || 0x00 || input)).
 */
function fakeAuthenticator(options: { prf?: boolean; prfAtCreate?: boolean; cancel?: boolean } = {}) {
  const { prf = true, prfAtCreate = true } = options
  const secrets = new Map<string, Uint8Array>()
  async function evaluate(secret: Uint8Array, input: BufferSource): Promise<ArrayBuffer> {
    const salt = await crypto.subtle.digest('SHA-256', new Uint8Array([...new TextEncoder().encode('WebAuthn PRF'), 0, ...toBytes(input)]))
    const key = await crypto.subtle.importKey('raw', secret as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return crypto.subtle.sign('HMAC', key, salt)
  }
  const domError = (name: string) => Object.assign(new Error(name), { name })
  const credentials = {
    async create({ publicKey }: CredentialCreationOptions) {
      if (options.cancel) throw domError('NotAllowedError')
      if (publicKey!.authenticatorSelection?.userVerification !== 'required') throw new Error('expected user verification')
      if (publicKey!.excludeCredentials?.some((c) => secrets.has(b64u(toBytes(c.id))))) throw domError('InvalidStateError')
      const id = crypto.getRandomValues(new Uint8Array(16))
      const secret = crypto.getRandomValues(new Uint8Array(32))
      secrets.set(b64u(id), secret)
      const input = (publicKey!.extensions as { prf?: { eval?: { first: BufferSource } } }).prf?.eval?.first
      const results = prf && prfAtCreate && input ? { first: await evaluate(secret, input) } : undefined
      return { rawId: id.buffer, getClientExtensionResults: () => (prf ? { prf: { enabled: true, ...(results ? { results } : {}) } } : {}) }
    },
    async get({ publicKey }: CredentialRequestOptions) {
      if (options.cancel) throw domError('NotAllowedError')
      const allowed = publicKey!.allowCredentials!.map((c) => b64u(toBytes(c.id))).find((id) => secrets.has(id))
      if (!allowed) throw domError('NotAllowedError')
      const byCred = (publicKey!.extensions as { prf?: { evalByCredential?: Record<string, { first: BufferSource }> } }).prf?.evalByCredential
      const input = byCred?.[allowed]?.first
      const results = prf && input ? { first: await evaluate(secrets.get(allowed)!, input) } : undefined
      return { rawId: fromB64u(allowed).slice().buffer, getClientExtensionResults: () => (results ? { prf: { results } } : {}) }
    },
    forget: (id: string) => secrets.delete(id),
  }
  return credentials as unknown as CredentialsContainer & { forget(id: string): void }
}

function memoryWrapper() {
  let stored: CryptoKey | undefined
  return browserWrapper(async () => stored, async (k) => { stored = k })
}

describe('passkey app lock (WebAuthn PRF)', () => {
  it('wraps the data key so only the passkey that made the slot opens it', async () => {
    const authenticator = fakeAuthenticator()
    const ceremonies = browserCeremonies(authenticator)
    const wrapper = memoryWrapper()
    const dataKey = newDataKey()
    let record: VaultRecord = { v: 1, wrap: 'browser', data: b64u(await wrapper.wrap(dataKey)) }

    const salt = newPasskeySalt()
    const made = await createPasskey(ceremonies, 'app.iskra.foo', { id: b64u(new Uint8Array(16)), name: 'Ada' }, salt, [])
    record = await addPasskeySlot(record, dataKey, wrapper, { id: made.id, name: 'Laptop', salt, prf: made.prf, rpId: 'app.iskra.foo' })
    expect(isLocked(record)).toBe(true)
    // Passkey only: nothing else holds the data key any more.
    expect(record.data).toBe('')
    expect(JSON.stringify(record)).not.toContain(b64u(made.prf))

    const salts = Object.fromEntries(record.passkeys!.map((p) => [p.id, p.salt]))
    const got = await getPasskeySecret(ceremonies, 'app.iskra.foo', salts)
    expect(got.id).toBe(made.id)
    expect(await openPasskeySlot(record, wrapper, got.id, got.prf)).toEqual(dataKey)
    // A wrong secret, an unknown id or another device's wrap: nothing.
    expect(await openPasskeySlot(record, wrapper, got.id, crypto.getRandomValues(new Uint8Array(32)))).toBeNull()
    expect(await openPasskeySlot(record, wrapper, 'nope', got.prf)).toBeNull()
    expect(await openPasskeySlot(record, memoryWrapper(), got.id, got.prf)).toBeNull()
  })

  it('keeps several passkeys and the passphrase side by side', async () => {
    const phone = fakeAuthenticator({ prfAtCreate: false }) // PRF only on get(): a second prompt while setting up
    const key = fakeAuthenticator()
    const wrapper = memoryWrapper()
    const dataKey = newDataKey()
    let record = await withPassphrase({ v: 1, wrap: 'browser', data: '' }, dataKey, wrapper, 'correct horse battery', CHEAP)
    const user = { id: b64u(new Uint8Array(16)), name: 'Ada' }
    for (const [authenticator, name] of [[phone, 'Phone'], [key, 'Security key']] as const) {
      const salt = newPasskeySalt()
      const made = await createPasskey(browserCeremonies(authenticator), 'localhost', user, salt, (record.passkeys ?? []).map((p) => p.id))
      record = await addPasskeySlot(record, dataKey, wrapper, { id: made.id, name, salt, prf: made.prf, rpId: 'localhost' })
    }
    expect(record.passkeys!.map((p) => p.name)).toEqual(['Phone', 'Security key'])
    expect(record.data).not.toBe('') // the passphrase box is still there
    const salts = Object.fromEntries(record.passkeys!.map((p) => [p.id, p.salt]))
    for (const authenticator of [phone, key]) {
      const got = await getPasskeySecret(browserCeremonies(authenticator), 'localhost', salts)
      expect(await openPasskeySlot(record, wrapper, got.id, got.prf)).toEqual(dataKey)
    }

    // The same authenticator again: refused (excludeCredentials).
    await expect(createPasskey(browserCeremonies(key), 'localhost', user, newPasskeySalt(), record.passkeys!.map((p) => p.id)))
      .rejects.toMatchObject({ problem: 'exists' })

    // Removing the passphrase keeps the passkeys; removing every passkey too unlocks the vault.
    record = await withPassphrase(record, dataKey, wrapper, null, CHEAP)
    expect(record.lock).toBeUndefined()
    expect(isLocked(record)).toBe(true)
    for (const p of [...record.passkeys!]) record = await removePasskeySlot(record, p.id, dataKey, wrapper)
    expect(isLocked(record)).toBe(false)
    expect(await wrapper.unwrap(fromB64u(record.data))).toEqual(dataKey)
  })

  it('explains authenticators without PRF and cancelled prompts', async () => {
    const user = { id: b64u(new Uint8Array(16)), name: 'Ada' }
    await expect(createPasskey(browserCeremonies(fakeAuthenticator({ prf: false })), 'localhost', user, newPasskeySalt(), []))
      .rejects.toMatchObject({ problem: 'no-prf' })
    await expect(createPasskey(browserCeremonies(fakeAuthenticator({ cancel: true })), 'localhost', user, newPasskeySalt(), []))
      .rejects.toBeInstanceOf(PasskeyError)
    await expect(getPasskeySecret(browserCeremonies(fakeAuthenticator({ cancel: true })), 'localhost', { AAAA: 'AAAA' }))
      .rejects.toMatchObject({ problem: 'cancelled' })
  })
})
