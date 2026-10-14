import { describe, expect, it } from 'vitest'
import { serverSections } from '../settings/sections'
import { FLAT_MAX, serverMenuLayout } from './serverMenuLayout'

const sectionsFor = (...args: Parameters<typeof serverSections>) => serverSections(...args).map((s) => s.id)
const rowsOf = (layout: ReturnType<typeof serverMenuLayout>) =>
  layout.rows.map((r) => (r.kind === 'section' || r.kind === 'settings' ? `${r.kind}:${r.section}` : r.kind))

describe('server menu', () => {
  it('owner: the common things flat, the rest under More settings', () => {
    const layout = serverMenuLayout(sectionsFor('owner'), { invite: true, createChannel: true })
    expect(rowsOf(layout)).toEqual(['invite', 'channel', 'settings:overview', 'section:members', 'section:roles', 'section:reports', 'more'])
    expect(layout.more).toEqual(['channels', 'emoji', 'gifs', 'sounds', 'pages', 'rules', 'automod', 'audit', 'securityLog', 'integrations', 'bugInbox', 'internet', 'limits', 'backup', 'import', 'updates'])
  })

  it('admin: the same shape without the owner-only sections', () => {
    const layout = serverMenuLayout(sectionsFor('admin'), { invite: true, createChannel: true })
    expect(rowsOf(layout)).toEqual(['invite', 'channel', 'settings:overview', 'section:members', 'section:roles', 'section:reports', 'more'])
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
    expect(rowsOf(five)).toEqual(['channel', 'settings:channels', 'section:roles', 'more'])
    expect(five.more).toEqual(['channels', 'emoji', 'sounds', 'audit'])
  })

  it('never makes a submenu of one', () => {
    const two = serverMenuLayout(['members', 'roles', 'reports', 'audit', 'automod'], { invite: false, createChannel: false })
    expect(two.more).toEqual(['audit', 'automod'])
    const one = serverMenuLayout(['overview', 'members', 'roles', 'reports', 'audit'], { invite: false, createChannel: false })
    expect(one.more).toEqual([])
    expect(rowsOf(one)).toEqual(['settings:overview', 'section:members', 'section:roles', 'section:reports', 'section:audit'])
  })
})
