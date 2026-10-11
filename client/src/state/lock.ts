// Keys at rest: which protection this device uses, and the optional app lock passphrase.
// The encryption itself lives in core/vault.ts and core/storage.ts.
import { t } from '../i18n'
import { create } from 'zustand'
import { b64u, fromB64u } from '../core/crypto'
import * as storage from '../core/storage'
import type { KeyWrapper, WrapKind } from '../core/vault'
import { desktop } from '../platform/desktop'

export type Protection = 'keychain' | 'browser' | 'browser-no-keyring'

interface LockState {
  /** open: keys are readable. locked: waiting for the app lock passphrase. error: the keychain didn't cooperate. */
  status: 'unknown' | 'open' | 'locked' | 'error'
  message?: string
  protection: Protection | null
  /** An app lock passphrase is set. */
  passphrase: boolean
}

export const useLock = create<LockState>(() => ({ status: 'unknown', protection: null, passphrase: false }))

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
  useLock.setState({ passphrase: passphrase !== null })
}

export const checkPassphrase = (passphrase: string) => storage.checkLockPassphrase(passphrase)
