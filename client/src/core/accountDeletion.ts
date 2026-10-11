// Deleting an account: a statement signed by the account key, handed to every server the account is on.
// See "Deleting an account" in protocol/PROTOCOL.md.
import { b64u, fromB64u, sign, signedPayload, u64be, verify } from './crypto'
import type { Identity } from './identity'
import type { AccountDeletion } from './protocol'

export const DELETE_CONTEXT = 'iskra/account-delete/v1'

const payload = (accountKey: Uint8Array, deletedAt: number, messages: boolean) =>
  signedPayload(DELETE_CONTEXT, accountKey, u64be(deletedAt), Uint8Array.of(messages ? 1 : 0))

export function signDeletion(identity: Identity, messages: boolean, deletedAt = Date.now()): AccountDeletion {
  const account = identity.account.publicKey
  return { accountKey: b64u(account), deletedAt, messages, sig: b64u(sign(payload(account, deletedAt, messages), identity.account.secretKey)) }
}

/** Only a deletion signed by this very account counts, so a server can't make a device wipe itself. */
export function verifyDeletion(accountKey: string, d: AccountDeletion | null | undefined): d is AccountDeletion {
  try {
    if (!d || d.accountKey !== accountKey || typeof d.messages !== 'boolean') return false
    if (!Number.isSafeInteger(d.deletedAt) || d.deletedAt < 0) return false
    const account = fromB64u(accountKey)
    return account.length === 32 && verify(fromB64u(d.sig), payload(account, d.deletedAt, d.messages), account)
  } catch {
    return false
  }
}
