import { describe, expect, it } from 'vitest'
import { settingsSections } from './sections'

const ids = (role: Parameters<typeof settingsSections>[0]) => settingsSections(role).map((s) => s.id)
const account = ['profile', 'appearance', 'devices', 'recovery', 'notifications', 'voice']

describe('settings sections', () => {
  it('shows only your account without a server', () => {
    expect(ids(null)).toEqual(account)
  })

  it('shows server sections by role', () => {
    expect(ids('guest')).toEqual([...account, 'overview'])
    expect(ids('member')).toEqual([...account, 'overview'])
    expect(ids('trusted')).toEqual([...account, 'overview', 'sounds'])
    expect(ids('admin')).toEqual([...account, 'overview', 'emoji', 'sounds', 'integrations', 'pages', 'internet'])
    expect(ids('owner')).toEqual([...ids('admin'), 'backup', 'import'])
  })

  it('groups account before server', () => {
    const groups = settingsSections('owner').map((s) => s.group)
    expect(groups.indexOf('server')).toBe(account.length)
    expect(groups.lastIndexOf('account')).toBe(account.length - 1)
  })
})
