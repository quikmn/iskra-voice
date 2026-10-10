import { describe, expect, it } from 'vitest'
import type { Channel, Member, StageState, VoiceParticipant } from '../core/protocol'
import type { ServerState } from './store'
import { isStageModerator, listenerLabel, maySpeak, stageView } from './stages'

const p = (accountKey: string): VoiceParticipant => ({ accountKey, muted: false, deafened: false })
const state = (patch: Partial<StageState> = {}): StageState => ({
  channelId: 7, live: true, topic: 'Game night', startedAt: 1, startedBy: 'ann', speakers: [], hands: [], moderators: [], ...patch,
})
const member = (accountKey: string, role: Member['role']): Member => ({ accountKey, name: accountKey, role, online: true })
const server = {
  members: { ann: member('ann', 'admin'), bob: member('bob', 'member'), cat: member('cat', 'guest') },
} as unknown as ServerState
const stage: Channel = { id: 7, name: 'town-hall', kind: 'stage', position: 0, readRole: 'guest', writeRole: 'member' }

describe('stage view', () => {
  it('puts speakers on top in the order they came up, raised hands first in the audience', () => {
    const view = stageView(
      state({ speakers: ['cat', 'ann'], hands: [{ accountKey: 'eve', raisedAt: 2 }, { accountKey: 'dan', raisedAt: 3 }] }),
      [p('ann'), p('bob'), p('cat'), p('dan'), p('eve')],
    )
    expect(view.speakers.map((x) => x.accountKey)).toEqual(['cat', 'ann'])
    expect(view.hands).toEqual(['eve', 'dan'])
    expect(view.audience.map((x) => x.accountKey)).toEqual(['eve', 'dan', 'bob'])
  })

  it('ignores speakers and hands of people who already left', () => {
    const view = stageView(state({ speakers: ['gone'], hands: [{ accountKey: 'left', raisedAt: 1 }] }), [p('bob')])
    expect(view.speakers).toEqual([])
    expect(view.hands).toEqual([])
    expect(view.audience.map((x) => x.accountKey)).toEqual(['bob'])
  })

  it('treats everyone as audience before the server has told us anything', () => {
    expect(stageView(undefined, [p('a'), p('b')]).audience).toHaveLength(2)
    expect(listenerLabel(1)).toBe('1 listening')
  })
})

describe('stage roles', () => {
  it('admins and picked members moderate', () => {
    expect(isStageModerator(server, state(), 'ann')).toBe(true)
    expect(isStageModerator(server, state(), 'bob')).toBe(false)
    expect(isStageModerator(server, state({ moderators: ['bob'] }), 'bob')).toBe(true)
    expect(isStageModerator(server, state({ moderators: ['ghost'] }), 'ghost')).toBe(false)
  })

  it('writers and moderators may ask to speak', () => {
    expect(maySpeak(server, stage, state(), 'bob')).toBe(true)
    expect(maySpeak(server, stage, state(), 'cat')).toBe(false)
    expect(maySpeak(server, stage, state({ moderators: ['cat'] }), 'cat')).toBe(true)
  })
})
