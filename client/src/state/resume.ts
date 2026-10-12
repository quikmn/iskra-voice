// Putting things back after a reconnect (a server restart or a network drop): getting back into the voice or stage
// channel you were in, with the same mute and deafen. Messages are caught up in store.ts; stages and watch parties
// rebuild from `welcome` in their own files. See "Restarts and reconnecting" in PROTOCOL.md.
import { create } from 'zustand'
import { t } from '../i18n'
import type { Events } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { planVoice, RESUME_MAX_TRIES } from './resumeLogic'
import {
  clearVoiceResume, currentVoice, leaveVoice, onVoiceDropped, pauseVoiceFor, rejoinVoice, resyncVoiceFlags, useVoice, voiceConnected, voiceResume, type VoiceResume,
} from './voice'

/** serverKey → the server went through "restarting" since it was last online. */
const restarted = new Set<string>()
/** serverKey → "Back" is showing (a moment after a restart). */
export const useResume = create<{ back: Record<string, number> }>(() => ({ back: {} }))

const BACK_MS = 2_500

useApp.subscribe((state, prev) => {
  if (state.servers === prev.servers) return
  for (const [key, server] of Object.entries(state.servers)) {
    const before = prev.servers[key]?.status.state
    if (server.status.state === 'restarting') {
      restarted.add(key)
      if (before !== 'restarting') void pauseVoiceFor(key)
    }
    else if (server.status.state === 'online' && before !== 'online' && restarted.has(key)) {
      // The restart banner says "Back" for a moment, then goes.
      const at = Date.now()
      useResume.setState((s) => ({ back: { ...s.back, [key]: at } }))
      setTimeout(() => useResume.setState((s) => {
        if (s.back[key] !== at) return s
        const back = { ...s.back }
        delete back[key]
        return { back }
      }), BACK_MS)
    }
  }
})

let tries = 0
let waiting: VoiceResume | null = null
let rejoining = false
let timer: ReturnType<typeof setTimeout> | null = null

async function rejoin(where: VoiceResume): Promise<void> {
  if (rejoining) return
  if (timer) clearTimeout(timer)
  timer = null
  waiting = null
  rejoining = true
  let ok = false
  try {
    ok = await rejoinVoice(where)
  } finally {
    rejoining = false
  }
  if (ok) {
    tries = 0
    return
  }
  // voice.join or LiveKit failed: a couple more tries, then leave it with the error showing.
  if (++tries < RESUME_MAX_TRIES) later(where, 2_000)
  else {
    tries = 0
    clearVoiceResume()
  }
}

/** One rejoin at a time, when the server is there and nobody joined something else meanwhile. */
function later(where: VoiceResume, ms: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const session = useVoice.getState().session
    if (session && session.state !== 'reconnecting') return // in voice again, or somewhere else now
    if (!connectionFor(where.serverKey)?.isOnline) return // the welcome after it's back does it
    if (!useApp.getState().servers[where.serverKey]?.voiceAvailable) {
      waiting = where
      return
    }
    void rejoin(where)
  }, ms)
}

onWelcomeHook((serverKey, welcome) => {
  const wasRestart = restarted.delete(serverKey)
  const plan = planVoice({
    serverKey,
    pending: voiceResume(),
    live: currentVoice(),
    liveConnected: voiceConnected(),
    restarted: wasRestart,
    channels: welcome.channels,
    voiceAvailable: welcome.voiceAvailable,
    now: Date.now(),
  })
  switch (plan.kind) {
    case 'resync':
      resyncVoiceFlags()
      return
    case 'gone':
      clearVoiceResume()
      if (useVoice.getState().session?.serverKey === serverKey) void leaveVoice()
      useVoice.setState({ error: t('voice.errors.resumeGone') })
      return
    case 'wait':
      waiting = plan.where
      return
    case 'rejoin':
      tries = 0
      void rejoin(plan.where)
  }
})

onServerEvent((serverKey, type, body) => {
  if (type !== 'voice.available' || !(body as Events['voice.available']).available) return
  const where = waiting ?? voiceResume()
  if (where?.serverKey === serverKey) later(where, 0)
})

// The room dropped while the server is still there (LiveKit restarted, a network blip LiveKit couldn't ride out):
// try again in a moment. If the server is away too, the welcome after it's back does it.
onVoiceDropped((where) => {
  if (!rejoining) later(where, 1_000)
})
