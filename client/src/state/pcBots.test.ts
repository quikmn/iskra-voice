import { describe, expect, it } from 'vitest'
import type { PcBot } from '../platform/desktop'
import { botLight, inviteServers, looksLikeBotInvite, problemKey } from './pcBots'
import type { ServerState } from './store'

const server = (key: string, name: string, role: string | null, online = true) =>
  ({ key, name, status: { state: online ? 'online' : 'offline' }, me: role ? { role } : null }) as unknown as ServerState

const bot = (patch: Partial<PcBot>): PcBot => ({
  id: 'trivia', kind: 'gallery', gallery: 'trivia', name: 'Trivia', autostart: false, settings: {}, state: 'stopped', online: false,
  needsInvite: false, problem: null, ...patch,
})

describe('bots on this PC', () => {
  it('offers bot invites only from servers where you are an admin, and online', () => {
    const list = inviteServers({
      a: server('a', 'Zed', 'owner'), b: server('b', 'Alpha', 'admin'), c: server('c', 'Mid', 'trusted'),
      d: server('d', 'Gone', 'admin', false), e: server('e', 'Joining', null),
    })
    expect(list.map((s) => s.name)).toEqual(['Alpha', 'Zed'])
  })

  it('recognises bot invite links', () => {
    expect(looksLikeBotInvite(' https://app.iskra.foo/#/join/abc ')).toBe(true)
    expect(looksLikeBotInvite('https://app.iskra.foo/')).toBe(false)
    expect(looksLikeBotInvite('hello')).toBe(false)
  })

  it('reads a bot\'s state as one light', () => {
    expect(botLight(bot({}))).toBe('stopped')
    expect(botLight(bot({ state: 'starting' }))).toBe('starting')
    expect(botLight(bot({ state: 'running', online: true }))).toBe('online')
    expect(botLight(bot({ state: 'running', online: false }))).toBe('offline')
    expect(botLight(bot({ state: 'failed', problem: '1' }))).toBe('failed')
  })

  it('says why a bot ended', () => {
    expect(problemKey(null)).toBeNull()
    expect(problemKey('no-python')).toEqual({ key: 'noPython' })
    expect(problemKey('no-entry')).toEqual({ key: 'noEntry' })
    expect(problemKey('not-trusted')).toEqual({ key: 'notTrusted' })
    expect(problemKey('3')).toEqual({ key: 'exit', code: '3' })
  })
})
