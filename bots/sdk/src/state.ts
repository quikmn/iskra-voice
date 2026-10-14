// A bot's keys and server address, kept in one JSON file (readable only by its owner).
// The keys are a normal Iskra identity: an account key and one device key certified by it.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { b64u, fromB64u, randomBytes, signingKeyPairFromSeed } from '../../../client/src/core/crypto'
import { certifyDevice, type Identity } from '../../../client/src/core/identity'
import type { StoredPrekey } from './dms'

export interface BotState {
  v: 1
  accountSeed: string
  deviceSeed: string
  created: number
  /** Set after the first successful join, so later starts don't need the invite. */
  server?: { url: string; key: string }
  /** The device's X25519 prekeys for forward-secret DMs (rotated weekly; old secrets deleted after 30 days). */
  prekeys?: StoredPrekey[]
}

export function newState(now = Date.now()): BotState {
  return { v: 1, accountSeed: b64u(randomBytes(32)), deviceSeed: b64u(randomBytes(32)), created: now }
}

export function identityOf(state: BotState): Identity {
  const account = signingKeyPairFromSeed(fromB64u(state.accountSeed))
  const device = signingKeyPairFromSeed(fromB64u(state.deviceSeed))
  const prekeys = (state.prekeys ?? []).map((p) => ({
    publicKey: fromB64u(p.publicKey), secretKey: fromB64u(p.secretKey), created: p.created, ...(p.retiredAt !== undefined ? { retiredAt: p.retiredAt } : {}),
  }))
  return { account, device, cert: certifyDevice(account, device.publicKey, state.created), prekeys }
}

export function loadState(path: string): BotState | null {
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8')) as BotState
  if (state.v !== 1 || typeof state.accountSeed !== 'string' || typeof state.deviceSeed !== 'string' || typeof state.created !== 'number')
    throw new Error(`${path} isn't a bot state file.`)
  return state
}

/** Written to a temp file and renamed, so a crash never leaves half a key file. */
export function saveState(path: string, state: BotState): void {
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    /* not supported on every file system */
  }
}
