import { describe, expect, it } from 'vitest'
import { serverSections } from '../settings/sections'
import { FLAT_MAX, serverMenuLayout } from './serverMenuLayout'

const sectionsFor = (...args: Parameters<typeof serverSections>) => serverSections(...args).map((s) => s.id)
const rowsOf = (layout: ReturnType<typeof serverMenuLayout>) =>
  layout.rows.map((r) => (r.kind === 'section' || r.kind === 'settings' ? `${r.kind}:${r.section}` : r.kind))

describe('server menu', () => {
  it('owner: Server settings, and every other section under More settings', () => {
    const layout = serverMenuLayout(sectionsFor('owner'), { invite: true, createChannel: true })
    expect(rowsOf(layout)).toEqual(['invite', 'channel', 'settings:overview', 'more'])
    expect(layout.more).toEqual(['channels', 'serverVoice', 'emoji', 'gifs', 'sounds', 'pages', 'rules', 'onboarding', 'translate', 'members', 'roles', 'reports', 'automod', 'audit', 'securityLog', 'integrations', 'activities', 'internet', 'limits', 'backup', 'export', 'import', 'updates'])
  })

  it('admin: the same shape without the owner-only sections', () => {
    const layout = serverMenuLayout(sectionsFor('admin'), { invite: true, createChannel: true })
    expect(rowsOf(layout)).toEqual(['invite', 'channel', 'settings:overview', 'more'])
    expect(layout.more).toContain('members')
    expect(layout.more).not.toContain('backup')
    expect(layout.more).not.toContain('securityLog')
  })

  it('member: no settings rows at all', () => {
    const layout = serverMenuLayout(sectionsFor('member'), { invite: true, createChannel: false })
    expect(rowsOf(layout)).toEqual(['invite'])
    expect(layout.more).toEqual([])
  })

  it('moderator: Server settings opens on their first section, and their sections are listed flat', () => {
    const kicker = serverMenuLayout(sectionsFor('member', (p) => p === 'kickMembers'), { invite: true, createChannel: false })
    expect(rowsOf(kicker)).toEqual(['invite', 'settings:members', 'section:members', 'section:reports'])
    const reportsOnly = serverMenuLayout(['reports'], { invite: true, createChannel: false })
    expect(rowsOf(reportsOnly)).toEqual(['invite', 'settings:reports', 'section:reports'])
  })

  it('soundboard rights only: Soundboard directly, no More settings', () => {
    const layout = serverMenuLayout(sectionsFor('trusted'), { invite: true, createChannel: false })
    expect(rowsOf(layout)).toEqual(['invite', 'settings:sounds', 'section:sounds'])
  })

  it(`lists ${FLAT_MAX} or fewer sections flat, more than that behind More settings`, () => {
    const four = serverMenuLayout(['channels', 'emoji', 'sounds', 'audit'], { invite: false, createChannel: true })
    expect(four.more).toEqual([])
    expect(rowsOf(four)).toEqual(['channel', 'settings:channels', 'section:channels', 'section:emoji', 'section:sounds', 'section:audit'])
    const five = serverMenuLayout(['channels', 'emoji', 'sounds', 'roles', 'audit'], { invite: false, createChannel: true })
    expect(rowsOf(five)).toEqual(['channel', 'settings:channels', 'more'])
    expect(five.more).toEqual(['channels', 'emoji', 'sounds', 'roles', 'audit'])
  })

  it('Server settings is never repeated as a row of its own', () => {
    const two = serverMenuLayout(['overview', 'members'], { invite: false, createChannel: false })
    expect(two.more).toEqual([])
    expect(rowsOf(two)).toEqual(['settings:overview', 'section:members'])
  })
})
