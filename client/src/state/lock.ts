// Keys at rest: which protection this device uses, and the optional app lock passphrase.
// The encryption itself lives in core/vault.ts and core/storage.ts.
import { t } from '../i18n'
import { create } from 'zustand'
import { b64u, fromB64u } from '../core/crypto'
import * as storage from '../core/storage'
import type { KeyWrapper, WrapKind } from '../core/vault'
import { desktop } from '../platform/desktop'
import { createPasskey, getPasskeySecret, PasskeyError, passkeyPlatform } from '../platform/passkeys'
import { newPasskeySalt } from '../core/vault'

export type Protection = 'keychain' | 'browser' | 'browser-no-keyring'

interface LockState {
  /** open: keys are readable. locked: waiting for the app lock passphrase. error: the keychain didn't cooperate. */
  status: 'unknown' | 'open' | 'locked' | 'error'
  message?: string
  protection: Protection | null
  /** An app lock passphrase is set. */
  passphrase: boolean
  /** Passkeys that open the app lock on this device. */
  passkeys: PasskeyInfo[]
}

export interface PasskeyInfo {
  id: string
  name: string
  rpId: string
  created: number
  lastUsed?: number
}

export const useLock = create<LockState>(() => ({ status: 'unknown', protection: null, passphrase: false, passkeys: [] }))

const refreshInfo = () => {
  const info = storage.vaultInfo()
  useLock.setState({ passphrase: info.locked, passkeys: info.passkeys })
}

/** The desktop app's OS keychain as a key wrapper, if it has a real one. */
async function keychainWrapper(): Promise<{ wrapper: KeyWrapper | null; noKeyring: boolean }> {
  const keychain = desktop?.keychain
  if (!keychain) return { wrapper: null, noKeyring: false }
  const status = await keychain.status().catch(() => 'unavailable' as const)
  if (status !== 'keyring') return { wrapper: null, noKeyring: status === 'basic' }
  return {
    noKeyring: false,
    wrapper: {
      kind: 'system',
      async wrap(data) {
        const out = await keychain.encrypt(b64u(data))
        if (!out) throw new Error("The keychain didn't encrypt.")
        return new TextEncoder().encode(out)
      },
      async unwrap(data) {
        const out = await keychain.decrypt(new TextDecoder().decode(data))
        if (!out) throw new Error("The keychain didn't decrypt.")
        return fromB64u(out)
      },
    },
  }
}

function describe(wrap: WrapKind | null, noKeyring: boolean): Protection | null {
  if (!wrap) return null
  return wrap === 'system' ? 'keychain' : noKeyring ? 'browser-no-keyring' : 'browser'
}

let noKeyring = false

/** Opens the vault at startup. Resolves true once keys are readable. */
export async function openDeviceVault(): Promise<boolean> {
  const system = await keychainWrapper()
  noKeyring = system.noKeyring
  const result = await storage.openVault(system.wrapper)
  const info = storage.vaultInfo()
  useLock.setState({
    status: result.state,
    message: result.state === 'error' ? result.message : undefined,
    protection: describe(info.wrap, noKeyring),
    passphrase: info.locked,
    passkeys: info.passkeys,
  })
  return result.state === 'open'
}

/** The app lock: true if the passphrase was right. */
export async function unlock(passphrase: string): Promise<boolean> {
  const ok = await storage.unlockVault(passphrase)
  if (ok) useLock.setState({ status: 'open' })
  return ok
}

export const MIN_PASSPHRASE = 8

export async function setPassphrase(passphrase: string | null): Promise<void> {
  if (passphrase !== null && passphrase.length < MIN_PASSPHRASE) throw new Error(t('keys.errors.minLength', { min: MIN_PASSPHRASE }))
  await storage.setLockPassphrase(passphrase)
  refreshInfo()
}

export const checkPassphrase = (passphrase: string) => storage.checkLockPassphrase(passphrase)

// ── Passkeys ────────────────────────────────────────────────────────────────

/** Passkeys this device's app can use (its relying party id), from the ones set up. */
function usableSlots(): Record<string, string> {
  const platform = passkeyPlatform()
  if (!platform) return {}
  return Object.fromEntries(storage.passkeySlots().filter((s) => s.rpId === platform.rpId).map((s) => [s.id, s.salt]))
}

export const canUsePasskeys = () => passkeyPlatform() !== null

/** The lock screen: true once a passkey opened the keys. Throws PasskeyError (cancelled, no-prf, ...). */
export async function unlockWithPasskey(): Promise<boolean> {
  const platform = passkeyPlatform()
  const salts = usableSlots()
  if (!platform || !Object.keys(salts).length) throw new PasskeyError('unsupported')
  const { id, prf } = await getPasskeySecret(platform.ceremonies, platform.rpId, salts)
  const ok = await storage.unlockVaultWithPasskey(id, prf)
  prf.fill(0)
  if (ok) {
    useLock.setState({ status: 'open' })
    refreshInfo()
  }
  return ok
}

/** Asks for one of the existing passkeys (before changing the lock when there's no passphrase to ask for). */
export async function confirmWithPasskey(): Promise<boolean> {
  const platform = passkeyPlatform()
  const salts = usableSlots()
  if (!platform || !Object.keys(salts).length) return false
  const { id, prf } = await getPasskeySecret(platform.ceremonies, platform.rpId, salts)
  // The PRF output must actually open the slot: a different passkey with the same id can't pass.
  return storage.checkPasskey(id, prf)
}

/** A name for a new passkey, from what kind of device this is. The person can rename it. */
export function defaultPasskeyName(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/iPhone|iPad/.test(ua)) return 'iPhone or iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Mac OS X|Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows Hello'
  if (/Linux|CrOS/.test(ua)) return 'Linux'
  return 'Passkey'
}

/** Makes a passkey and lets it open the app lock. Throws PasskeyError ('no-prf' when the authenticator can't). */
export async function addPasskeyLock(name: string, accountName: string): Promise<void> {
  const platform = passkeyPlatform()
  if (!platform) throw new PasskeyError('unsupported')
  const salt = newPasskeySalt()
  const user = { id: await storage.passkeyUserId(), name: accountName || 'Iskra' }
  const exclude = storage.passkeySlots().filter((s) => s.rpId === platform.rpId).map((s) => s.id)
  const { id, prf } = await createPasskey(platform.ceremonies, platform.rpId, user, salt, exclude)
  await storage.addPasskey({ id, name: name.trim() || defaultPasskeyName(), salt, prf, rpId: platform.rpId })
  prf.fill(0)
  refreshInfo()
}

export async function removePasskeyLock(id: string): Promise<void> {
  await storage.removePasskey(id)
  refreshInfo()
}

export async function renamePasskeyLock(id: string, name: string): Promise<void> {
  if (!name.trim()) return
  await storage.renamePasskey(id, name.trim())
  refreshInfo()
}
