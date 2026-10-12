import { describe, expect, it } from 'vitest'
import { planVoice, RESUME_MAX_AGE_MS, type WelcomeFacts } from './resumeLogic'

const where = { serverKey: 's1', channelId: 2, camera: false, screen: true, stageOpen: false, at: 1_000 }
const facts = (patch: Partial<WelcomeFacts>): WelcomeFacts => ({
  serverKey: 's1', pending: null, live: null, liveConnected: false, restarted: false,
  channels: [{ id: 1, kind: 'text' }, { id: 2, kind: 'voice' }, { id: 3, kind: 'stage' }], voiceAvailable: true, now: 2_000, ...patch,
})

describe('getting back into voice after a reconnect', () => {
  it('rejoins the channel whose room dropped', () => {
    expect(planVoice(facts({ pending: where }))).toEqual({ kind: 'rejoin', where })
    expect(planVoice(facts({ pending: { ...where, channelId: 3 } }))).toMatchObject({ kind: 'rejoin' }) // stages too
  })

  it('leaves other servers alone', () => {
    expect(planVoice(facts({ serverKey: 's2', pending: where }))).toEqual({ kind: 'none' })
    expect(planVoice(facts({ serverKey: 's2', live: where, restarted: true }))).toEqual({ kind: 'none' })
  })

  it('only says mute and deafen again when the room is still connected', () => {
    expect(planVoice(facts({ live: where, liveConnected: true, restarted: true }))).toEqual({ kind: 'resync' })
  })

  it('starts over after a restart, but lets LiveKit finish its own reconnect after a network drop', () => {
    expect(planVoice(facts({ live: where, restarted: true }))).toEqual({ kind: 'rejoin', where })
    expect(planVoice(facts({ live: where, restarted: false }))).toEqual({ kind: 'none' })
  })

  it('gives up when the channel is gone or is no longer a voice channel', () => {
    expect(planVoice(facts({ pending: { ...where, channelId: 9 } }))).toEqual({ kind: 'gone' })
    expect(planVoice(facts({ pending: { ...where, channelId: 1 } }))).toEqual({ kind: 'gone' })
  })

  it('waits for voice when LiveKit is not up yet', () => {
    expect(planVoice(facts({ pending: where, voiceAvailable: false }))).toEqual({ kind: 'wait', where })
  })

  it('forgets an old drop', () => {
    expect(planVoice(facts({ pending: where, now: where.at + RESUME_MAX_AGE_MS + 1 }))).toEqual({ kind: 'none' })
  })
})
