import { describe, expect, it } from 'vitest'
import { settingsSections } from './sections'

const ids = (role: Parameters<typeof settingsSections>[0]) => settingsSections(role).map((s) => s.id)
const account = ['profile', 'appearance', 'devices', 'recovery', 'security', 'notifications', 'voice', 'blocked', 'account', 'about']

describe('settings sections', () => {
  it('shows only your account without a server', () => {
    expect(ids(null)).toEqual(account)
  })

  it('shows server sections by role', () => {
    expect(ids('guest')).toEqual([...account, 'overview'])
    expect(ids('member')).toEqual([...account, 'overview'])
    expect(ids('trusted')).toEqual([...account, 'overview', 'sounds'])
    expect(ids('admin')).toEqual([...account, 'overview', 'reports', 'roles', 'automod', 'emoji', 'sounds', 'integrations', 'pages', 'internet', 'audit', 'rules'])
    expect(ids('owner')).toEqual([...ids('admin'), 'limits', 'backup', 'import', 'updates'])
  })

  it('opens sections for the permissions a custom role gives', () => {
    expect(settingsSections('member', (p) => p === 'viewAuditLog' || p === 'manageRoles').map((s) => s.id))
      .toEqual([...account, 'overview', 'roles', 'audit'])
    expect(settingsSections('member', (p) => p === 'kickMembers').map((s) => s.id)).toEqual([...account, 'overview', 'reports'])
  })

  it('shows Desktop app only in the desktop app', () => {
    const withDesktop = [...account.slice(0, 8), 'desktop', ...account.slice(8)]
    expect(settingsSections(null, undefined, true).map((s) => s.id)).toEqual(withDesktop)
    expect(settingsSections('admin', undefined, true).map((s) => s.id).indexOf('desktop')).toBe(8)
  })

  it('groups account before server', () => {
    const groups = settingsSections('owner').map((s) => s.group)
    expect(groups.indexOf('server')).toBe(account.length)
    expect(groups.lastIndexOf('account')).toBe(account.length - 1)
  })
})
