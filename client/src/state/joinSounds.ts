// Join sounds: the soundboard sound you picked on a server is played for the others when you enter a voice channel
// there. The server sends "play this" to the people in the channel (as for the soundboard); each app plays it itself.
import { create } from 'zustand'
import type { Events, JoinSoundChoice } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook } from './store'
import { playUrl, serverFileUrl, useExpressions } from './expressions'
import { useVoice } from './voice'
import { isBlocked, useBlocks } from './moderation'
import { noteJoinSound } from './notify'
import { JOIN_SOUND_MAX_MS, joinSoundVolume } from './joinSoundLogic'
import { t } from '../i18n'

interface JoinSoundsState {
  /** Your choice on each server (missing: not known yet, or a server without join sounds). */
  mine: Record<string, JoinSoundChoice>
  /** Servers that know join sounds at all (older ones don't). */
  supported: Record<string, boolean>
  /** Whether you hear other people's join sounds (this device). */
  hear: boolean
}

const HEAR_KEY = 'iskra.joinSounds'

function loadHear(): boolean {
  try {
    return localStorage.getItem(HEAR_KEY) !== 'off'
  } catch {
    return true
  }
}

export const useJoinSounds = create<JoinSoundsState>(() => ({ mine: {}, supported: {}, hear: loadHear() }))

export function setHearJoinSounds(hear: boolean): void {
  useJoinSounds.setState({ hear })
  try {
    localStorage.setItem(HEAR_KEY, hear ? 'on' : 'off')
  } catch {
    /* private mode */
  }
}

const keep = (serverKey: string, choice: JoinSoundChoice) => useJoinSounds.setState((s) => ({ mine: { ...s.mine, [serverKey]: choice } }))

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('expressions.errors.notConnected'))
  return c
}

/** Picks your join sound on a server; null for none. */
export async function setJoinSound(serverKey: string, id: string | null): Promise<void> {
  keep(serverKey, await connection(serverKey).request('joinsound.set', { id }))
}

/** The owner's switch for the whole server. */
export async function setJoinSoundsEnabled(serverKey: string, enabled: boolean): Promise<void> {
  await connection(serverKey).request('joinsound.configure', { enabled })
}

function onPlayed(serverKey: string, { channelId, accountKey, sound }: Events['joinsound.played']): void {
  const voice = useVoice.getState()
  // Only for the call you're in on this device (another device of yours may be the one in voice).
  if (voice.session?.serverKey !== serverKey || voice.session.channelId !== channelId) return
  const { settings } = useExpressions.getState()
  const volume = joinSoundVolume({
    hear: useJoinSounds.getState().hear,
    soundboardMuted: settings.muted,
    soundboardVolume: settings.volume,
    deafened: voice.deafened,
    personal: voice.volumes[accountKey] ?? 1,
    blocked: isBlocked(useBlocks.getState().entries, accountKey),
  })
  const url = serverFileUrl(serverKey, sound.url)
  if (volume <= 0 || !url) return
  noteJoinSound(serverKey, channelId, accountKey)
  playUrl(url, volume, useJoinSounds.getState().mine[serverKey]?.maxMs ?? JOIN_SOUND_MAX_MS)
}

onServerEvent((serverKey, type, body) => {
  switch (type) {
    case 'joinsound.played':
      onPlayed(serverKey, body as Events['joinsound.played'])
      return
    case 'joinsound.updated':
      keep(serverKey, body as Events['joinsound.updated'])
      return
    case 'joinsound.enabled': {
      const { enabled } = body as Events['joinsound.enabled']
      useJoinSounds.setState((s) => (s.mine[serverKey] ? { mine: { ...s.mine, [serverKey]: { ...s.mine[serverKey], enabled } } } : s))
      return
    }
  }
})

onWelcomeHook((serverKey, welcome) => {
  const supported = welcome.server.joinSounds !== undefined
  useJoinSounds.setState((s) => ({ supported: { ...s.supported, [serverKey]: supported } }))
  if (!supported) return
  void connectionFor(serverKey)?.request('joinsound.get', {}).then((choice) => keep(serverKey, choice)).catch(() => undefined)
})
