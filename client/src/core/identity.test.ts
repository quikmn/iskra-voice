import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, fromB64u, ready, signingKeyPairFromSeed } from './crypto'
import { certifyDevice, createIdentity, signAuth, verifyDeviceCert } from './identity'
import vectors from '../../../protocol/vectors.json'

beforeAll(ready)

describe('device certificates', () => {
  it('a fresh identity has a valid certificate', () => {
    const id = createIdentity()
    expect(verifyDeviceCert(id.cert)).toBe(true)
  })

  it('rejects a certificate whose device key was swapped', () => {
    const id = createIdentity()
    const other = createIdentity()
    expect(verifyDeviceCert({ ...id.cert, deviceKey: other.cert.deviceKey })).toBe(false)
  })

  it('rejects a certificate whose timestamp was changed', () => {
    const id = createIdentity()
    expect(verifyDeviceCert({ ...id.cert, created: id.cert.created + 1 })).toBe(false)
  })

  it('rejects garbage without throwing', () => {
    expect(verifyDeviceCert({ accountKey: 'x', deviceKey: '!!', created: -1, sig: '' })).toBe(false)
  })
})

describe('shared test vectors (must match the C# server)', () => {
  const v = vectors.v1
  // Derived once libsodium is ready (describe bodies run before beforeAll).
  let account: ReturnType<typeof signingKeyPairFromSeed>
  let device: ReturnType<typeof signingKeyPairFromSeed>
  beforeAll(async () => {
    await ready()
    account = signingKeyPairFromSeed(fromB64u(v.accountSeed))
    device = signingKeyPairFromSeed(fromB64u(v.deviceSeed))
  })

  it('derives the expected public keys', () => {
    expect(b64u(account.publicKey)).toBe(v.accountKey)
    expect(b64u(device.publicKey)).toBe(v.deviceKey)
  })

  it('produces the expected device certificate', () => {
    expect(certifyDevice(account, device.publicKey, v.created)).toEqual(v.cert)
  })

  it('produces the expected auth signature', () => {
    expect(signAuth(device, fromB64u(v.serverKey), fromB64u(v.nonce))).toBe(v.authSig)
  })
})
