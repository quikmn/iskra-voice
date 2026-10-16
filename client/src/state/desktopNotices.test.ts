import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissNoticeToast, parseDesktopNotice, showDesktopNotice, TOAST_MS, useDesktopNotices } from './desktopNotices'
import { useApp } from './store'

describe('the desktop shell’s notices', () => {
  it('accepts what the shell sends, and nothing odd', () => {
    expect(parseDesktopNotice({ kind: 'update-check', result: 'up-to-date', version: '2.0.0-alpha.24' })).toEqual({ kind: 'update-check', result: 'up-to-date', version: '2.0.0-alpha.24' })
    expect(parseDesktopNotice({ kind: 'update-check', result: 'found', version: '2.1.0' })).toEqual({ kind: 'update-check', result: 'found', version: '2.1.0' })
    expect(parseDesktopNotice({ kind: 'about' })).toEqual({ kind: 'about' })
    expect(parseDesktopNotice({ kind: 'screen-permission', extra: 1 })).toEqual({ kind: 'screen-permission' })
    for (const bad of [
      null, 'about', { kind: 'nope' }, { kind: 'update-check' }, { kind: 'update-check', result: 'maybe', version: '2.0.0' },
      { kind: 'update-check', result: 'failed', version: '<img src=x>' }, { kind: 'update-check', result: 'failed', version: 'v2.0.0' },
    ]) expect(parseDesktopNotice(bad)).toBeNull()
  })

  describe('shown', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      useDesktopNotices.setState({ toast: null, dialog: null })
    })
    afterEach(() => vi.useRealTimers())

    it('an update check result is a toast that goes by itself', () => {
      showDesktopNotice({ kind: 'update-check', result: 'up-to-date', version: '2.0.0' })
      expect(useDesktopNotices.getState().toast?.notice).toEqual({ kind: 'update-check', result: 'up-to-date', version: '2.0.0' })
      vi.advanceTimersByTime(TOAST_MS - 1)
      expect(useDesktopNotices.getState().toast).not.toBeNull()
      vi.advanceTimersByTime(1)
      expect(useDesktopNotices.getState().toast).toBeNull()
    })

    it('a newer toast replaces the old one and keeps its own time', () => {
      showDesktopNotice({ kind: 'update-check', result: 'failed', version: '2.0.0' })
      vi.advanceTimersByTime(TOAST_MS - 100)
      showDesktopNotice({ kind: 'update-check', result: 'off', version: '2.0.0' })
      vi.advanceTimersByTime(200)
      expect(useDesktopNotices.getState().toast?.notice).toMatchObject({ result: 'off' })
      dismissNoticeToast()
      expect(useDesktopNotices.getState().toast).toBeNull()
    })

    it('the screen permission is a dialog; About is a toast until the app has settings to open', () => {
      showDesktopNotice({ kind: 'screen-permission' })
      expect(useDesktopNotices.getState().dialog).toEqual({ kind: 'screen-permission' })
      expect(useApp.getState().phase).not.toBe('ready')
      showDesktopNotice({ kind: 'about' })
      expect(useDesktopNotices.getState().toast?.notice).toEqual({ kind: 'about' })
    })
  })
})
