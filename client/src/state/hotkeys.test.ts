import { describe, expect, it } from 'vitest'
import { desktopTypesText, matchesWebHotkey, parseHotkeys, typesText, webHotkeyFrom, webHotkeyLabel, webKeyName } from './hotkeys'

const key = (code: string, key: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
  ({ code, key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })

describe('browser hotkeys', () => {
  it('names keys', () => {
    expect(webKeyName('KeyM', 'm')).toBe('M')
    expect(webKeyName('Digit1', '!')).toBe('1')
    expect(webKeyName('Numpad7', '7')).toBe('Num 7')
    expect(webKeyName('F9', 'F9')).toBe('F9')
    expect(webKeyName('ArrowUp', 'ArrowUp')).toBe('Up')
    expect(webKeyName('Backquote', '`')).toBe('`')
    expect(webKeyName('Space', ' ')).toBe('Space')
    expect(webHotkeyLabel({ code: 'KeyM', ctrl: true, shift: true, alt: false, meta: false }, 'M', false)).toBe('Ctrl + Shift + M')
    expect(webHotkeyLabel({ code: 'KeyD', ctrl: false, shift: false, alt: true, meta: true }, 'd', true)).toBe('Option + Cmd + D')
  })

  it('captures a combo, waits through modifiers, and cancels on Escape', () => {
    expect(webHotkeyFrom(key('ControlLeft', 'Control', { ctrlKey: true }))).toBeNull()
    expect(webHotkeyFrom(key('ShiftRight', 'Shift', { shiftKey: true }))).toBeNull()
    expect(webHotkeyFrom(key('Escape', 'Escape'))).toBe('cancel')
    expect(webHotkeyFrom(key('KeyM', 'M', { ctrlKey: true, shiftKey: true }), false)).toEqual({
      code: 'KeyM', ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl + Shift + M',
    })
    expect(webHotkeyFrom(key('Escape', 'Escape', { shiftKey: true }), false)).toMatchObject({ code: 'Escape', shift: true })
  })

  it('matches only with exactly the same modifiers', () => {
    const h = { code: 'KeyM', ctrl: true, shift: false, alt: false, meta: false, label: 'Ctrl + M' }
    expect(matchesWebHotkey(key('KeyM', 'm', { ctrlKey: true }), h)).toBe(true)
    expect(matchesWebHotkey(key('KeyM', 'm'), h)).toBe(false)
    expect(matchesWebHotkey(key('KeyM', 'M', { ctrlKey: true, shiftKey: true }), h)).toBe(false)
    expect(matchesWebHotkey(key('KeyN', 'n', { ctrlKey: true }), h)).toBe(false)
  })

  it('plain keys count as typing; Ctrl/Alt/Cmd combos and mouse buttons do not', () => {
    expect(typesText({ ctrl: false, alt: false, meta: false })).toBe(true)
    expect(typesText({ ctrl: true, alt: false, meta: false })).toBe(false)
    expect(desktopTypesText({ code: 50, mods: 0, label: 'M' })).toBe(true)
    expect(desktopTypesText({ code: 50, mods: 2, label: 'Shift + M' })).toBe(true)
    expect(desktopTypesText({ code: 50, mods: 1, label: 'Ctrl + M' })).toBe(false)
    expect(desktopTypesText({ code: 0x10004, mods: 0, label: 'Mouse 4' })).toBe(false)
  })
})

describe('stored hotkeys', () => {
  it('keeps only well-formed ones', () => {
    expect(parseHotkeys(null)).toEqual({ web: {}, desktop: {} })
    expect(parseHotkeys('not json')).toEqual({ web: {}, desktop: {} })
    expect(parseHotkeys('null')).toEqual({ web: {}, desktop: {} })
    const web = { code: 'KeyM', ctrl: true, shift: false, alt: false, meta: false, label: 'Ctrl + M' }
    const desk = { code: 65540, mods: 0, label: 'Mouse 4' }
    expect(parseHotkeys(JSON.stringify({ web: { mute: web, deafen: { code: 5 } }, desktop: { deafen: desk, mute: { code: 'x' }, other: desk } }))).toEqual({
      web: { mute: web },
      desktop: { deafen: desk },
    })
  })
})
