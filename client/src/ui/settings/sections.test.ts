import { describe, expect, it } from 'vitest'
import { mySections, serverSections } from './sections'

const ids = (role: Parameters<typeof serverSections>[0], can?: Parameters<typeof serverSections>[1]) => serverSections(role, can).map((s) => s.id)
const mine = ['profile', 'appearance', 'language', 'devices', 'recovery', 'security', 'notifications', 'voice', 'video', 'blocked', 'account', 'privacy', 'about']
const admin = ['overview', 'channels', 'emoji', 'gifs', 'sounds', 'pages', 'rules', 'members', 'roles', 'reports', 'automod', 'audit', 'integrations', 'internet']

describe('My settings', () => {
  it('holds only things about you, never a server section', () => {
    expect(mySections().map((s) => s.id)).toEqual(mine)
    expect(mySections().map((s) => s.label)).not.toContain('Overview')
  })

  it('shows Desktop app only in the desktop app', () => {
    expect(mySections(true).map((s) => s.id)).toEqual([...mine.slice(0, 10), 'desktop', ...mine.slice(10)])
  })
})

describe('server settings', () => {
  it('is empty without a membership or without any admin rights', () => {
    expect(ids(null)).toEqual([])
    expect(ids('guest')).toEqual([])
    expect(ids('member')).toEqual([])
  })

  it('shows sections by level, in nav order', () => {
    expect(ids('trusted')).toEqual(['sounds'])
    expect(ids('admin')).toEqual(admin)
    expect(ids('owner')).toEqual([
      'overview', 'channels', 'emoji', 'gifs', 'sounds', 'pages', 'rules',
      'members', 'roles', 'reports', 'automod', 'audit', 'securityLog',
      'integrations',
      'internet', 'limits', 'backup', 'import', 'updates',
    ])
  })

  it('opens sections for the permissions a custom role gives', () => {
    expect(ids('member', (p) => p === 'viewAuditLog' || p === 'manageRoles')).toEqual(['members', 'roles', 'audit'])
    expect(ids('member', (p) => p === 'kickMembers')).toEqual(['members', 'reports'])
    expect(ids('member', (p) => p === 'manageChannels')).toEqual(['channels'])
    expect(ids('member', (p) => p === 'manageExpressions')).toEqual(['emoji', 'sounds'])
  })

  it('groups the sections as Server, Members & safety, Apps, Hosting & data', () => {
    const groups = serverSections('owner').map((s) => `${s.group}:${s.id}`)
    expect(groups.filter((g) => g.startsWith('server:'))).toEqual(['server:overview', 'server:channels', 'server:emoji', 'server:gifs', 'server:sounds', 'server:pages', 'server:rules'])
    expect(groups.filter((g) => g.startsWith('safety:'))).toEqual(['safety:members', 'safety:roles', 'safety:reports', 'safety:automod', 'safety:audit', 'safety:securityLog'])
    expect(groups.filter((g) => g.startsWith('apps:'))).toEqual(['apps:integrations'])
    expect(groups.filter((g) => g.startsWith('hosting:'))).toEqual(['hosting:internet', 'hosting:limits', 'hosting:backup', 'hosting:import', 'hosting:updates'])
  })

  it('uses the plain names', () => {
    const label = Object.fromEntries(serverSections('owner').map((s) => [s.id, s.label]))
    expect(label.audit).toBe('Activity log')
    expect(label.internet).toBe('Internet access')
    expect(label.securityLog).toBe('Sign-ins & security')
    expect(label.emoji).toBe('Emoji & stickers')
    expect(label.gifs).toBe('GIFs')
    expect(label.rules).toBe('Server rules')
    expect(label.updates).toBe('Server updates')
  })
})
