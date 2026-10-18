// Voice and video calls in group DMs. The group's server rings everyone and hands out LiveKit tickets to current
// members only; the media key is random per call and travels in group envelopes, so the server and LiveKit only see
// encrypted media. When the member list changes, the person who has been in the call longest sends a new key
// (encrypted for the new list), so someone who left can't follow the call even if they still got its packets.
import { create } from 'zustand'
import { b64u, fromB64u, randomBytes } from '../core/crypto'
import { decryptGroup, GroupBehindError, type GroupEnvelope } from '../core/group'
import { RequestError, type GroupCallRing, type WireGroupCall } from '../core/protocol'
import { desktop } from '../platform/desktop'
import { isBusy } from './callMachine'
import { startRinging, stopRinging, useCalls } from './calls'
import { checkGroupKey, isNewerKey, keyholder, ringNotice } from './groupLogic'
import { groupKey, openGroup, sealForGroup, sendGroupMessage, syncGroup, titleOf, useGroups } from './groups'
import { nameOf } from './dms'
import { useNotify } from './notify'
import { focusThisAccount, notificationTitle } from './accountFocus'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { joinGroupCall, leaveVoice, setCallKey, useVoice } from './voice'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'

export interface GroupCallInfo extends WireGroupCall {
  serverKey: string
  /** The group's key in groups.ts. */
  key: string
}

interface GroupCallsState {
  /** Ongoing calls in your groups, by group key. */
  calls: Record<string, GroupCallInfo>
  /** A call ringing for you. */
  ringing: { key: string; callId: string; from: string; video: boolean } | null
  /** The call you're in. `hasKey`: we have its media key (a newcomer may wait a moment for a fresh one). */
  joined: { key: string; callId: string; joinedAt: number; hasKey: boolean } | null
  error: string | null
}

export const useGroupCalls = create<GroupCallsState>(() => ({ calls: {}, ringing: null, joined: null, error: null }))

/** The newest key accepted per call, with its group version, send time and LiveKit key index. Memory only, dropped when you leave. */
const accepted = new Map<string, { key: Uint8Array; version: number; sentAt: number; index: number }>()
const rekeyed = new Set<string>()
const RING_MS = 45_000
const ALONE_MS = 60_000

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

function remember(serverKey: string, call: WireGroupCall): GroupCallInfo {
  const info = { ...call, serverKey, key: groupKey(serverKey, call.group) }
  useGroupCalls.setState((s) => ({ calls: { ...s.calls, [info.key]: info } }))
  return info
}

/**
 * Decrypts and checks a key envelope: from someone in the group now, for a version of its chain we verified, for this
 * call. Anything else is ignored (never an unencrypted call).
 */
async function readKey(serverKey: string, call: WireGroupCall, envelope: GroupEnvelope) {
  const identity = useApp.getState().identity
  const key = groupKey(serverKey, call.group)
  if (!identity || !envelope?.header) return null
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = useGroups.getState().groups[key]?.view
    if (!view) {
      await syncGroup(key)
      continue
    }
    try {
      const { header, call: content } = decryptGroup(identity, envelope, { group: call.group, from: envelope.header.from, version: envelope.header.version }, view)
      if (!view.members.includes(header.from)) return null
      const checked = checkGroupKey(content, call.id)
      return checked ? { key: fromB64u(checked.key), index: checked.index, version: header.version, sentAt: header.sentAt } : null
    } catch (e) {
      if (e instanceof GroupBehindError && attempt === 0) {
        await syncGroup(key)
        continue
      }
      return null
    }
  }
  return null
}

async function acceptKey(callId: string, k: { key: Uint8Array; index: number; version: number; sentAt: number } | null): Promise<void> {
  if (!k || !isNewerKey(k, accepted.get(callId))) return
  accepted.set(callId, k)
  const joined = useGroupCalls.getState().joined
  if (joined?.callId === callId) {
    await setCallKey(k.key, k.index)
    if (!joined.hasKey) useGroupCalls.setState({ joined: { ...joined, hasKey: true } })
  }
}

const busy = () => isBusy(useCalls.getState().call) || !!useGroupCalls.getState().joined

export async function startGroupCall(key: string, video: boolean): Promise<void> {
  if (busy()) return
  const g = useGroups.getState().groups[key]
  const connection = g && connectionFor(g.serverKey)
  if (!g || !connection) return
  const callId = b64u(randomBytes(16))
  const mediaKey = randomBytes(32)
  useGroupCalls.setState({ error: null, joined: { key, callId, joinedAt: Date.now(), hasKey: true } })
  try {
    let result
    let sealed
    for (let attempt = 0; ; attempt++) {
      sealed = await sealForGroup(key, { text: 'Group call key', call: { kind: 'group-key', id: callId, key: b64u(mediaKey), index: 0, video } })
      try {
        result = await connection.request('gcall.start', { groupId: g.id, callId, version: sealed.version, video, envelope: sealed.envelope })
        break
      } catch (e) {
        if (!(e instanceof RequestError && e.code === 'conflict') || attempt > 0) throw e
        await syncGroup(key)
      }
    }
    accepted.set(callId, { key: mediaKey, version: sealed.version, sentAt: sealed.envelope.header.sentAt, index: 0 })
    remember(g.serverKey, result.call)
    if (useGroupCalls.getState().joined?.callId !== callId) {
      connection.request('gcall.leave', { callId }).catch(() => undefined) // hung up while it was starting
      return
    }
    void sendGroupMessage(key, video ? t('groups.sent.startedVideo') : t('groups.sent.startedVoice'), { call: { kind: 'group-start', id: callId, video } })
    const joined = await joinGroupCall(g.serverKey, { key, callId }, result.ticket, { key: mediaKey, index: 0 }, video)
    if (!joined) await leaveGroupCall(t('calls.couldNotConnect'))
    setTimeout(() => {
      // Nobody came: don't sit in an empty call forever.
      const call = useGroupCalls.getState().calls[key]
      if (useGroupCalls.getState().joined?.callId === callId && call && call.participants.every((p) => p === me()))
        void leaveGroupCall(t('groups.call.nobodyJoined'))
    }, ALONE_MS)
  } catch (e) {
    useGroupCalls.setState({ joined: null, error: errorMessage(e) })
  }
}

/** Joins the ongoing call in a group (or answers it ringing). */
export async function joinOngoingCall(key: string, camera = false): Promise<void> {
  const call = useGroupCalls.getState().calls[key]
  if (!call || isBusy(useCalls.getState().call)) return
  const current = useGroupCalls.getState().joined
  if (current?.callId === call.id) return
  if (current) await leaveGroupCall()
  const connection = connectionFor(call.serverKey)
  if (!connection) return
  useGroupCalls.setState({ ringing: null, error: null, joined: { key, callId: call.id, joinedAt: Date.now(), hasKey: false } })
  try {
    const { ring, ticket } = await connection.request('gcall.join', { callId: call.id })
    remember(call.serverKey, ring.call)
    const k = await readKey(call.serverKey, ring.call, ring.envelope)
    if (k && isNewerKey(k, accepted.get(call.id))) accepted.set(call.id, k)
    const best = accepted.get(call.id) ?? null
    useGroupCalls.setState((s) => ({ joined: s.joined && { ...s.joined, hasKey: !!best } }))
    openGroup(key)
    const joined = await joinGroupCall(call.serverKey, { key, callId: call.id }, ticket, best && { key: best.key, index: best.index }, camera)
    if (!joined) return void (await leaveGroupCall(t('calls.couldNotConnect')))
    // A newer key may have come in while we were connecting.
    const latest = accepted.get(call.id)
    if (latest && latest !== best) {
      await setCallKey(latest.key, latest.index)
      useGroupCalls.setState((s) => ({ joined: s.joined && { ...s.joined, hasKey: true } }))
    }
    maybeRekey()
  } catch {
    useGroupCalls.setState({ joined: null, error: t('calls.noLongerAvailable') })
  }
}

export function declineGroupCall(): void {
  const ringing = useGroupCalls.getState().ringing
  if (!ringing) return
  useGroupCalls.setState({ ringing: null })
  const call = useGroupCalls.getState().calls[ringing.key]
  if (call) connectionFor(call.serverKey)?.request('gcall.decline', { callId: ringing.callId }).catch(() => undefined)
}

export async function leaveGroupCall(error?: string): Promise<void> {
  const joined = useGroupCalls.getState().joined
  if (!joined) return
  useGroupCalls.setState({ joined: null, error: error ?? null })
  accepted.delete(joined.callId)
  const call = useGroupCalls.getState().calls[joined.key]
  if (useVoice.getState().session?.group?.callId === joined.callId) await leaveVoice()
  if (call) await connectionFor(call.serverKey)?.request('gcall.leave', { callId: joined.callId }).catch(() => undefined)
}

/**
 * The key is behind the group (someone joined or left it): if we've been in the call longest, send a new one for the
 * current member list. Everyone switches to it; LiveKit keeps the old one for frames still in flight.
 */
function maybeRekey(): void {
  const joined = useGroupCalls.getState().joined
  if (!joined?.hasKey) return
  const call = useGroupCalls.getState().calls[joined.key]
  const view = useGroups.getState().groups[joined.key]?.view
  if (!call || !view || call.id !== joined.callId || call.keyVersion >= view.version) return
  if (keyholder(call.participants, view.members) !== me()) return
  const marker = `${call.id}:${view.version}`
  if (rekeyed.has(marker)) return
  rekeyed.add(marker)
  void (async () => {
    const mediaKey = randomBytes(32)
    const index = ((accepted.get(call.id)?.index ?? 0) + 1) % 16
    try {
      const sealed = await sealForGroup(joined.key, { text: 'Group call key', call: { kind: 'group-key', id: call.id, key: b64u(mediaKey), index, video: call.video } })
      await connectionFor(call.serverKey)!.request('gcall.key', { callId: call.id, version: sealed.version, envelope: sealed.envelope })
      await acceptKey(call.id, { key: mediaKey, index, version: sealed.version, sentAt: sealed.envelope.header.sentAt })
    } catch {
      rekeyed.delete(marker) // try again on the next update
    }
  })()
}

function ended(key: string, callId: string): void {
  useGroupCalls.setState((s) => {
    const calls = { ...s.calls }
    if (calls[key]?.id === callId) delete calls[key]
    return { calls, ringing: s.ringing?.callId === callId ? null : s.ringing }
  })
  if (useGroupCalls.getState().joined?.callId === callId) void leaveGroupCall()
}

async function onRing(serverKey: string, ring: GroupCallRing): Promise<void> {
  const call = remember(serverKey, ring.call)
  if (call.from === me() || busy() || useGroupCalls.getState().ringing) return
  if (Date.now() - call.createdAt > RING_MS) return
  // Only ring for a call whose key we can read: the invite is really from someone in the group.
  const k = await readKey(serverKey, ring.call, ring.envelope)
  if (!k) return
  if (useGroupCalls.getState().calls[call.key]?.id !== call.id) return // ended meanwhile
  useGroupCalls.setState({ ringing: { key: call.key, callId: call.id, from: call.from, video: call.video } })
  setTimeout(() => {
    if (useGroupCalls.getState().ringing?.callId === call.id) useGroupCalls.setState({ ringing: null })
  }, RING_MS)
}

onServerEvent((serverKey, type, body) => {
  switch (type) {
    case 'gcall.ring':
      void onRing(serverKey, body as GroupCallRing)
      return
    case 'gcall.state':
      remember(serverKey, (body as { call: WireGroupCall }).call)
      maybeRekey()
      return
    case 'gcall.key': {
      const ring = body as GroupCallRing
      remember(serverKey, ring.call)
      void readKey(serverKey, ring.call, ring.envelope).then((k) => acceptKey(ring.call.id, k))
      return
    }
    case 'gcall.ended': {
      const { callId, group } = body as { callId: string; group: string }
      ended(groupKey(serverKey, group), callId)
      return
    }
    case 'gcall.ring.stopped': {
      const { callId } = body as { callId: string }
      if (useGroupCalls.getState().ringing?.callId === callId) useGroupCalls.setState({ ringing: null })
      return
    }
  }
})

onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('gcall.list', {})
    .then(({ calls }) => {
      for (const ring of calls) {
        if (ring.ringing) void onRing(serverKey, ring)
        else remember(serverKey, ring.call)
      }
    })
    .catch(() => undefined)
})

// The group changed: maybe it's on us to send a new key.
useGroups.subscribe((state, prev) => {
  const joined = useGroupCalls.getState().joined
  if (joined && state.groups[joined.key]?.view !== prev.groups[joined.key]?.view) maybeRekey()
})

// Another call took over the room (or it dropped): we're out of the group call.
useVoice.subscribe((state, prev) => {
  const joined = useGroupCalls.getState().joined
  if (joined && prev.session?.group?.callId === joined.callId && state.session?.group?.callId !== joined.callId) void leaveGroupCall()
})

// Ringing while a group call rings for you: the sound, the desktop app's attention, and (when the window isn't
// focused) a system notification, like a 1:1 call.
let notification: Notification | null = null

useGroupCalls.subscribe((state, prev) => {
  if (state.ringing?.callId === prev.ringing?.callId) return
  notification?.close()
  notification = null
  if (state.ringing) {
    startRinging('in')
    void desktop?.callAlert?.(true)
    const ringing = state.ringing
    const g = useGroups.getState().groups[ringing.key]
    const note = ringNotice(nameOf(ringing.from), g ? titleOf(g) : t('groups.call.ringGroup'), ringing.video, {
      focused: document.hasFocus(),
      enabled: useNotify.getState().desktop,
      permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    })
    if (note) {
      notification = new Notification(notificationTitle(note.title), { body: note.body, tag: `iskra-gcall-${ringing.callId}`, requireInteraction: true, silent: true })
      notification.onclick = () => {
        window.focus()
        focusThisAccount()
        openGroup(ringing.key)
        notification?.close()
      }
    }
  } else {
    if (!isBusy(useCalls.getState().call)) stopRinging()
    if (prev.ringing) void desktop?.callAlert?.(false)
  }
})

// Leaving a server archives its groups: forget their calls.
useApp.subscribe((state, prev) => {
  if (state.servers === prev.servers) return
  const { calls, ringing } = useGroupCalls.getState()
  const gone = Object.values(calls).filter((c) => !state.servers[c.serverKey])
  if (gone.length === 0) return
  const left = { ...calls }
  for (const c of gone) delete left[c.key]
  useGroupCalls.setState({ calls: left, ringing: ringing && gone.some((c) => c.id === ringing.callId) ? null : ringing })
})
