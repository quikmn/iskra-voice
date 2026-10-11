// Account key rotation in the app: replacing this account's key, following a rotation made on another of its
// devices, and following contacts who replaced theirs. See "Account key rotation" in protocol/PROTOCOL.md.
// Every rotation is checked here (both signatures); what a server says about one is never taken on trust.
import { t } from '../i18n'
import { create } from 'zustand'
import { b64u, generateSigningKeyPair } from '../core/crypto'
import { certifyDevice, type DeviceCert, type Identity } from '../core/identity'
import type { Events, Welcome } from '../core/protocol'
import {
  bareRotation, chainFrom, chainTo, openHandover, prepareRotation, signRotation, verifyRotation,
  type AppliedRotation, type Rotation,
} from '../core/rotation'
import { keyMap, keysReady, knownRotations, remember, replaceRotation, resolveKey } from './keyMap'
import * as storage from '../core/storage'
import { applyKeyChanges, devicesOf } from './dms'
import { connectionFor, onServerEvent, onWelcomeHook, patchServer, reconnectAll, setAuthRotations, useApp } from './store'

export interface Dispute {
  serverKey: string
  rotation: AppliedRotation
}

interface KeysState {
  /** This device's key was replaced and it wasn't handed the new one (another device, or someone with the old key). */
  retired: { rotations: Rotation[]; claimed: boolean } | null
  /** This device just moved to a new account key: show the new recovery key. */
  moved: 'here' | 'other-device' | null
  /** Accounts with two claims on one old key, by the key that currently holds them. */
  disputes: Record<string, Dispute[]>
  /** Contacts whose old key was claimed by two different new keys, as seen across servers. */
  conflicts: Record<string, string[]>
}

export const useKeys = create<KeysState>(() => ({ retired: null, moved: null, disputes: {}, conflicts: {} }))

const myKey = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

const onlineServers = () => {
  const { servers, order } = useApp.getState()
  return order.filter((key) => servers[key]?.status.state === 'online' && connectionFor(key))
}

let queue: Promise<unknown> = Promise.resolve()
/** Rotation handling runs one step at a time (several servers may report the same rotation at once). */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

// Servers that missed our rotation get the chain in the handshake.
setAuthRotations(() => {
  const key = myKey()
  return key ? chainTo(key, knownRotations()) : []
})

async function markRecoveryUnsaved(): Promise<void> {
  const profile = useApp.getState().profile
  if (!profile) return
  const next = { ...profile, recoverySaved: false }
  await storage.saveProfile(next)
  useApp.setState({ profile: next })
}

/** Switches this device to a new account key and reconnects everywhere. */
async function switchIdentity(identity: Identity, by: 'here' | 'other-device'): Promise<void> {
  await storage.saveIdentity(identity)
  await markRecoveryUnsaved()
  useApp.setState({ identity })
  applyKeyChanges(resolveKey, [])
  useKeys.setState({ retired: null, moved: by })
  reconnectAll()
}

// ── Replacing this account's key ────────────────────────────────────────────

/** This account's device certificates, as the servers we're on know them. */
export async function ownDeviceCerts(): Promise<DeviceCert[]> {
  const me = myKey()
  const lists = await Promise.all(onlineServers().map((key) => devicesOf(key, me).catch(() => [] as DeviceCert[])))
  const byDevice = new Map<string, DeviceCert>()
  for (const cert of lists.flat()) if (!byDevice.has(cert.deviceKey)) byDevice.set(cert.deviceKey, cert)
  return [...byDevice.values()]
}

/**
 * Makes a new account key, signs the hand-over with the old one, re-certifies the devices to keep (and seals the
 * new key to each of them), hands it all to every server we're on, and switches this device over.
 * Servers we can't reach now get it on our next connect.
 */
export function rotateAccountKey(keepDevices: string[]): Promise<void> {
  return serial(async () => {
    const identity = useApp.getState().identity
    if (!identity) throw new Error(t('keys.errors.noAccount'))
    await keysReady()
    const certs = (await ownDeviceCerts()).filter((c) => keepDevices.includes(c.deviceKey))
    const prepared = prepareRotation(identity, certs)
    const entry: storage.RotationOutbox = { rotation: prepared.rotation, certs: prepared.certs, handovers: prepared.handovers, done: [] }
    // Saved before anything is sent, so a crash midway can't leave this device without its new key.
    await storage.saveRotationOutbox([...(await storage.loadRotationOutbox()), entry])
    await remember([prepared.rotation])

    const servers = onlineServers()
    let conflicts = 0
    await Promise.all(servers.map(async (key) => {
      try {
        await connectionFor(key)!.request('account.rotate', { rotation: prepared.rotation, certs: prepared.certs, handovers: prepared.handovers })
        entry.done.push(key)
      } catch (e) {
        if ((e as { code?: string }).code === 'rotation_conflict') conflicts++
      }
    }))
    await saveDone(entry)
    if (servers.length > 0 && conflicts === servers.length) throw new Error(t('keys.errors.alreadyReplaced'))
    await switchIdentity(prepared.identity, 'here')
  })
}

async function saveDone(entry: storage.RotationOutbox): Promise<void> {
  const outbox = await storage.loadRotationOutbox()
  await storage.saveRotationOutbox(outbox.map((e) => (e.rotation.newKey === entry.rotation.newKey ? { ...e, done: [...new Set([...e.done, ...entry.done])] } : e)))
}

/** After connecting with the new key: hand the server the certificates and hand-overs it doesn't have yet. */
async function completeOutbox(serverKey: string): Promise<void> {
  const outbox = await storage.loadRotationOutbox()
  const me = myKey()
  for (const entry of outbox) {
    if (entry.done.includes(serverKey) || resolveKey(entry.rotation.newKey) !== me) continue
    try {
      await connectionFor(serverKey)?.request('account.rotate', { rotation: entry.rotation, certs: entry.certs, handovers: entry.handovers })
      await saveDone({ ...entry, done: [serverKey] })
    } catch {
      /* the server doesn't have the rotation (we joined it later) or is busy; nothing to do */
    }
  }
}

// ── Following a rotation of this account ────────────────────────────────────

/** A server says this device's account key is retired. Follow it if we were handed the new key, else tell the person. */
function onRetired(rotations: AppliedRotation[] | undefined, handover: string | null | undefined): Promise<void> {
  return serial(async () => {
    const identity = useApp.getState().identity
    if (!identity) return
    const mine = b64u(identity.account.publicKey)
    const chain = chainFrom(mine, (rotations ?? []).filter((r) => verifyRotation(r)))
    if (chain.length === 0) {
      // An admin settled a dispute against our key: the old key we came from now leads somewhere else.
      const lost = (rotations ?? []).find((r) => verifyRotation(r) && r.newKey !== mine && keyMap().same(r.oldKey, mine))
      if (lost) useKeys.setState({ retired: { rotations: [lost], claimed: false } })
      return // otherwise: about a key we already left, or not verifiable
    }
    if (handover) {
      const opened = openHandover(identity, handover, chain)
      if (opened) {
        await remember(chain.slice(0, chain.indexOf(opened.rotation) + 1))
        const next: Identity = { ...identity, account: opened.account, cert: certifyDevice(opened.account, identity.device.publicKey, Date.now()) }
        await switchIdentity(next, 'other-device')
        return
      }
    }
    useKeys.setState((s) => ({ retired: { rotations: chain, claimed: s.retired?.claimed ?? false } }))
  })
}

/**
 * "That wasn't me": sign a rotation from the (stolen) old key to a fresh key of ours. Where nobody rotated yet it
 * simply wins; where someone did, the server records a dispute for its admins.
 */
export function claimAccountBack(): Promise<void> {
  return serial(async () => {
    const identity = useApp.getState().identity
    if (!identity) return
    const account = generateSigningKeyPair()
    const rotation = signRotation(identity.account, account)
    const cert = certifyDevice(account, identity.device.publicKey, Date.now())
    await storage.saveRotationOutbox([...(await storage.loadRotationOutbox()), { rotation, certs: [cert], handovers: [], done: [] }])
    // Our view of the old key now points at our claim, not at the other one.
    await replaceRotation(rotation)
    useKeys.setState({ retired: null })
    await switchIdentity({ ...identity, account, cert }, 'here')
  })
}

/** Try again (the other device may still be handing over the new key). */
export function retryRetired(): void {
  useKeys.setState({ retired: null })
  reconnectAll()
}

// ── Contacts ────────────────────────────────────────────────────────────────

function setDispute(serverKey: string, rotation: AppliedRotation): void {
  useKeys.setState((s) => {
    const others = (s.disputes[rotation.newKey] ?? []).filter((d) => d.serverKey !== serverKey)
    const list = rotation.disputed ? [...others, { serverKey, rotation }] : others
    const disputes = { ...s.disputes }
    if (list.length) disputes[rotation.newKey] = list
    else delete disputes[rotation.newKey]
    return { disputes }
  })
}

/** A rotation a server reports for someone. Checked here, then their conversation and friend entry follow. */
async function learn(serverKey: string, rotation: AppliedRotation): Promise<void> {
  if (!verifyRotation(rotation)) return
  await keysReady()
  const me = myKey()
  // Only our own chain may move our old keys; a different claim on one of them is someone else's (see onRetired).
  if (keyMap().same(rotation.oldKey, me) && resolveKey(rotation.newKey) !== me) return
  setDispute(serverKey, rotation)
  const current = resolveKey(rotation.oldKey)
  if (current !== rotation.oldKey && resolveKey(rotation.newKey) !== current) {
    // Two different new keys for one old key, across servers: warn on both.
    useKeys.setState((s) => ({ conflicts: { ...s.conflicts, [rotation.oldKey]: [...new Set([...(s.conflicts[rotation.oldKey] ?? []), current, rotation.newKey])] } }))
    return
  }
  const added = await remember([rotation])
  if (added.length && rotation.oldKey !== me) applyKeyChanges(resolveKey, added.map((r) => ({ ...r, disputed: rotation.disputed })))
}

onWelcomeHook((serverKey, welcome: Welcome) => {
  void (async () => {
    for (const rotation of welcome.rotations ?? []) await learn(serverKey, rotation)
    await completeOutbox(serverKey)
  })()
})

onServerEvent((serverKey, type, body) => {
  switch (type) {
    case 'account.rotated': {
      const { rotations, handover } = body as Events['account.rotated']
      void onRetired(rotations, handover)
      return
    }
    case 'member.rotated': {
      const { rotation, member } = body as Events['member.rotated']
      patchServer(serverKey, (s) => {
        const members = { ...s.members }
        delete members[rotation.oldKey]
        members[member.accountKey] = member
        return { members }
      })
      void learn(serverKey, rotation)
      return
    }
    case 'account.disputed': {
      const { rotation } = body as Events['account.disputed']
      void learn(serverKey, rotation)
      return
    }
    case 'account.resolved': {
      const { rotation, previousKey, member } = body as Events['account.resolved']
      patchServer(serverKey, (s) => {
        const members = { ...s.members }
        delete members[previousKey]
        members[member.accountKey] = member
        return { members }
      })
      // Settled: the dispute was filed under whoever held the account then, which may be the losing key.
      setDispute(serverKey, { ...rotation, disputed: false })
      setDispute(serverKey, { ...rotation, newKey: previousKey, disputed: false })
      if (previousKey !== rotation.newKey && verifyRotation(rotation) && !keyMap().same(rotation.oldKey, myKey())) {
        // The admins gave the account to the other key: our view follows, with a fresh "safety number changed".
        void serial(async () => {
          await replaceRotation(bareRotation(rotation))
          applyKeyChanges((k) => (k === previousKey ? rotation.newKey : resolveKey(k)), [{ ...rotation, oldKey: previousKey }])
        })
      }
      return
    }
  }
})

// A sign-in refused because this key was retired (or our claim became a dispute).
useApp.subscribe((state, previous) => {
  for (const [key, server] of Object.entries(state.servers)) {
    const status = server.status
    if (status === previous.servers[key]?.status || status.state !== 'rejected') continue
    if (status.code === 'account_rotated' && status.detail) {
      const detail = status.detail as { rotations?: AppliedRotation[]; handover?: string | null }
      void onRetired(detail.rotations, detail.handover)
    }
    if (status.code === 'account_disputed') useKeys.setState({ retired: null })
  }
})

/** Admins settle a dispute: which of the two keys keeps the account on this server. */
export async function resolveDispute(serverKey: string, oldKey: string, keep: string): Promise<void> {
  await connectionFor(serverKey)!.request('account.dispute.resolve', { oldKey, keep })
}
