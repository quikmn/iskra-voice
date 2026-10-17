// Signing out of this device: optionally leave every server, tell the servers this device is gone (so DMs stop
// being encrypted to it), then forget everything Iskra stored here and start over at the first-run screen.
// Also what "Clear Iskra from this device" does when the keys can't be opened or the device was removed.
import { signRevocation } from '../core/devices'
import * as storage from '../core/storage'
import { disablePush } from './push'
import { forgetTranscripts } from './transcripts/transcriptCache'
import { connectionFor, leaveServer, useApp } from './store'

/** Settings kept after signing out: they belong to the device, not the account. */
const KEEP = new Set(['iskra.language', 'iskra.theme', 'iskra.audio'])

/** Gives up on slow servers: signing out must never hang. */
const within = <T,>(promise: Promise<T>, ms = 4000) =>
  Promise.race([promise.catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(resolve, ms))])

/** `after` runs once everything is wiped, right before the app restarts (e.g. to leave a notice for the next screen). */
export async function signOutThisDevice({ leaveServers = false, after }: { leaveServers?: boolean; after?: () => void } = {}): Promise<void> {
  const { identity, order } = useApp.getState()
  const online = order.filter((key) => connectionFor(key)?.isOnline)
  if (identity && online.length) {
    await within(disablePush())
    // Your other devices (and your friends' apps) stop encrypting to this one.
    const revocation = signRevocation(identity, identity.cert.deviceKey)
    await within(Promise.all(online.map(async (key) => {
      const connection = connectionFor(key)!
      // Owners can't leave their own server: there, only this device goes.
      if (leaveServers && await connection.request('member.leave', {}).then(() => true, () => false)) return
      await connection.request('device.revoke', revocation)
    })))
  }
  for (const key of [...order]) leaveServer(key)
  await storage.wipeAll().catch(() => undefined)
  await forgetTranscripts()
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('iskra.') && !KEEP.has(key)) localStorage.removeItem(key)
    sessionStorage.clear()
  } catch {
    /* storage blocked: nothing to clear */
  }
  after?.()
  window.location.reload()
}
