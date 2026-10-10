// Account and device identity. See "Identity" in protocol/PROTOCOL.md.
import {
  b64u,
  fromB64u,
  generateSigningKeyPair,
  sign,
  signedPayload,
  u64be,
  verify,
  type SigningKeyPair,
} from './crypto'

export const DEVICE_CERT_CONTEXT = 'iskra/device-cert/v1'
export const AUTH_CONTEXT = 'iskra/auth/v1'

export interface DeviceCert {
  accountKey: string
  deviceKey: string
  created: number
  sig: string
}

export interface Identity {
  account: SigningKeyPair
  device: SigningKeyPair
  cert: DeviceCert
  /** This device's X25519 prekeys for forward-secret DMs (see core/devices.ts). Loaded separately. */
  prekeys?: import('./devices').PrekeyPair[]
}

export function certifyDevice(account: SigningKeyPair, devicePublicKey: Uint8Array, created: number): DeviceCert {
  const sig = sign(signedPayload(DEVICE_CERT_CONTEXT, devicePublicKey, u64be(created)), account.secretKey)
  return {
    accountKey: b64u(account.publicKey),
    deviceKey: b64u(devicePublicKey),
    created,
    sig: b64u(sig),
  }
}

export function verifyDeviceCert(cert: DeviceCert): boolean {
  try {
    const deviceKey = fromB64u(cert.deviceKey)
    if (deviceKey.length !== 32) return false
    const payload = signedPayload(DEVICE_CERT_CONTEXT, deviceKey, u64be(cert.created))
    return verify(fromB64u(cert.sig), payload, fromB64u(cert.accountKey))
  } catch {
    return false
  }
}

/** First launch: a brand-new account with this device as its first device. */
export function createIdentity(now: number = Date.now()): Identity {
  const account = generateSigningKeyPair()
  const device = generateSigningKeyPair()
  return { account, device, cert: certifyDevice(account, device.publicKey, now) }
}

/** The handshake signature: proves this device is talking to *this* server, *now*. */
export function signAuth(device: SigningKeyPair, serverKey: Uint8Array, nonce: Uint8Array): string {
  return b64u(sign(signedPayload(AUTH_CONTEXT, serverKey, nonce), device.secretKey))
}
