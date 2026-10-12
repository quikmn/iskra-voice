import { describe, expect, it } from 'vitest'
import { parseUpdateStatus, parseUpdatingVersion, updateNotice } from './updates'

const url = 'https://github.com/quikmn/iskra-voice/releases/tag/v2.0.0-alpha.3'

describe('desktop updates', () => {
  it('accepts the statuses the shell sends', () => {
    expect(parseUpdateStatus({ state: 'ready', version: '2.0.0-alpha.3' })).toEqual({ state: 'ready', version: '2.0.0-alpha.3' })
    expect(parseUpdateStatus({ state: 'downloading', version: '2.0.1' })).toEqual({ state: 'downloading', version: '2.0.1' })
    expect(parseUpdateStatus({ state: 'available', version: '2.0.0-alpha.3', url })).toEqual({ state: 'available', version: '2.0.0-alpha.3', url })
  })

  it('rejects anything odd', () => {
    expect(parseUpdateStatus(null)).toEqual({ state: 'none' })
    expect(parseUpdateStatus({ state: 'none' })).toEqual({ state: 'none' })
    expect(parseUpdateStatus({ state: 'ready', version: '<b>hi</b>' })).toEqual({ state: 'none' })
    expect(parseUpdateStatus({ state: 'available', version: '2.0.1', url: 'https://evil.example/iskra.exe' })).toEqual({ state: 'none' })
    expect(parseUpdateStatus({ state: 'available', version: '2.0.1', url: 'javascript:alert(1)' })).toEqual({ state: 'none' })
  })

  it('shows a notice until that version is dismissed', () => {
    expect(updateNotice({ state: 'none' }, null)).toBeNull()
    expect(updateNotice({ state: 'downloading', version: '2.0.1' }, null)).toBeNull()
    expect(updateNotice({ state: 'ready', version: '2.0.1' }, null)).toEqual({ kind: 'ready', version: '2.0.1' })
    expect(updateNotice({ state: 'ready', version: '2.0.1' }, '2.0.1')).toBeNull()
    expect(updateNotice({ state: 'available', version: '2.0.1', url }, '2.0.0')).toEqual({ kind: 'available', version: '2.0.1', url })
    expect(updateNotice({ state: 'available', version: '2.0.1', url }, '2.0.1')).toBeNull()
  })

  it('only shows "Updating Iskra to X" for a real version', () => {
    expect(parseUpdatingVersion('2.0.0-alpha.13')).toBe('2.0.0-alpha.13')
    for (const bad of [null, 7, '', 'v2.0.0', '<img src=x>', '2.0.0-' + 'x'.repeat(60)]) expect(parseUpdatingVersion(bad)).toBeNull()
  })
})
