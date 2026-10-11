// Deleting your account: a statement signed by the account key goes to every server you're on, then this device
// forgets everything. Your other devices get the same statement the next time they connect anywhere it was applied,
// check the signature, pass it on to their servers and wipe themselves too. See "Deleting an account" in PROTOCOL.md.
import { signDeletion, verifyDeletion } from '../core/accountDeletion'
import { b64u } from '../core/crypto'
import type { AccountDeletion, Events } from '../core/protocol'
import { isMember, leaveGroup, useGroups } from './groups'
import { disablePush } from './push'
import { signOutThisDevice } from './signOut'
import { connectionFor, onServerEvent, patchServer, useApp } from './store'

const NOTICE_KEY = 'iskra.accountDeleted'

/** Never hang on a slow server. */
const within = <T,>(promise: Promise<T>, ms = 5000) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])

export interface DeletionPlan {
  /** Servers you own: hand them over (or shut them down) first. */
  owned: string[]
  /** Connected servers where the account will be deleted. */
  reachable: string[]
  /** Servers we can't reach right now: the account stays there for now. */
  unreachable: string[]
}

export function deletionPlan(): DeletionPlan {
  const { servers, order } = useApp.getState()
  const plan: DeletionPlan = { owned: [], reachable: [], unreachable: [] }
  for (const key of order) {
    const server = servers[key]
    if (!server) continue
    if (server.me?.role === 'owner') plan.owned.push(key)
    else if (server.status.state === 'online' && server.me) plan.reachable.push(key)
    // Rejected (banned, kicked, gone): nothing of yours to delete there through the app.
    else if (server.status.state !== 'rejected') plan.unreachable.push(key)
  }
  return plan
}

let deleting = false

/** Hands the deletion to each server; resolves with the servers that refused or couldn't be reached. */
async function deliver(deletion: AccountDeletion, keys: string[]): Promise<string[]> {
  const failed: string[] = []
  await Promise.all(keys.map(async (key) => {
    const connection = connectionFor(key)
    if (!connection?.isOnline) return void failed.push(key)
    try {
      await within(connection.request('account.delete', { deletion }))
    } catch {
      failed.push(key)
    }
  }))
  return failed
}

/**
 * Deletes the account everywhere it can, then wipes this device and restarts at the first-run screen.
 * Leaves your groups first (signed changes, so the others' apps see you go).
 */
export async function deleteAccount({ messages }: { messages: boolean }): Promise<{ failed: string[] }> {
  const identity = useApp.getState().identity
  if (!identity) return { failed: [] }
  const plan = deletionPlan()
  if (plan.owned.length) throw new Error('owner')
  deleting = true
  try {
    const groups = Object.values(useGroups.getState().groups).filter(isMember).map((g) => g.key)
    await Promise.all(groups.map((key) => within(leaveGroup(key)).catch(() => undefined)))
    await within(disablePush()).catch(() => undefined)
    const failed = await deliver(signDeletion(identity, messages), plan.reachable)
    await wipe()
    return { failed }
  } finally {
    deleting = false
  }
}

const wipe = () => signOutThisDevice({
  after: () => {
    try {
      sessionStorage.setItem(NOTICE_KEY, '1')
    } catch {
      /* no notice then */
    }
  },
})

/** Shown once on the first-run screen after a deletion. */
export function takeDeletedNotice(): boolean {
  try {
    const shown = sessionStorage.getItem(NOTICE_KEY) === '1'
    sessionStorage.removeItem(NOTICE_KEY)
    return shown
  } catch {
    return false
  }
}

let handling = false

/** Another device deleted the account: check it really was this account, pass it on, then forget everything here. */
async function deletedElsewhere(deletion: unknown): Promise<void> {
  const identity = useApp.getState().identity
  if (!identity || deleting || handling) return
  const mine = b64u(identity.account.publicKey)
  if (!verifyDeletion(mine, deletion as AccountDeletion)) return
  handling = true
  const { order, servers } = useApp.getState()
  await deliver(deletion as AccountDeletion, order.filter((k) => servers[k]?.status.state === 'online' && servers[k]?.me?.role !== 'owner'))
  await wipe()
}

onServerEvent((serverKey, type, body) => {
  if (type === 'account.deleted') void deletedElsewhere((body as Events['account.deleted']).deletion)
  if (type === 'member.deleted') {
    const { accountKey, messages } = body as Events['member.deleted']
    if (!messages) return
    // Their messages are gone from the server: drop them (and their reactions) from what we have loaded.
    patchServer(serverKey, (s) => ({
      messages: Object.fromEntries(Object.entries(s.messages).map(([channel, list]) => [channel, list
        .filter((m) => m.author !== accountKey)
        .map((m) => (m.reactions.some((r) => r.accounts.includes(accountKey))
          ? { ...m, reactions: m.reactions.map((r) => ({ ...r, accounts: r.accounts.filter((a) => a !== accountKey) })).filter((r) => r.accounts.length > 0) }
          : m))])),
    }))
  }
})

// A sign-in refused because the account was deleted: the error carries the signed deletion.
useApp.subscribe((state, previous) => {
  for (const [key, server] of Object.entries(state.servers)) {
    const status = server.status
    if (status === previous.servers[key]?.status || status.state !== 'rejected' || status.code !== 'account_deleted') continue
    void deletedElsewhere((status.detail as { deletion?: unknown } | undefined)?.deletion)
  }
})

/** The owner hands a server to another member (needed before deleting their account). */
export async function transferOwnership(serverKey: string, accountKey: string): Promise<void> {
  await connectionFor(serverKey)!.request('owner.transfer', { accountKey })
}
