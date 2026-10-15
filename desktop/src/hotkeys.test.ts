import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComboCapture, HotkeyMatcher, hotkeyName, ModifierTracker, MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, modsOf, MOUSE, parseHotkeys } from './hotkeys'

const CTRL = 29
const SHIFT = 42
const M = 50
const D = 32
const ESC = 1
const name = (code: number) => (code >= MOUSE ? `Mouse ${code - MOUSE}` : ({ 29: 'Ctrl', 42: 'Shift', 50: 'M', 32: 'D' } as Record<number, string>)[code] ?? `Key ${code}`)
const mods = (ctrl = false, shift = false, alt = false, meta = false) => modsOf({ ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta })

test('hotkeys from the page are validated', () => {
  assert.deepEqual(parseHotkeys(null), {})
  assert.deepEqual(parseHotkeys('x'), {})
  assert.deepEqual(parseHotkeys({ mute: { code: M, mods: MOD_CTRL | 64 }, deafen: { code: 'x' }, other: { code: D } }), { mute: { code: M, mods: MOD_CTRL } })
  assert.deepEqual(parseHotkeys({ mute: { code: -1 }, deafen: { code: MOUSE + 99 } }), {})
  assert.deepEqual(parseHotkeys({ deafen: { code: MOUSE + 4 } }), { deafen: { code: MOUSE + 4, mods: 0 } })
  // A modifier key on its own doesn't count itself as held.
  assert.deepEqual(parseHotkeys({ mute: { code: CTRL, mods: MOD_CTRL } }), { mute: { code: CTRL, mods: 0 } })
})

test('hotkey names', () => {
  assert.equal(hotkeyName({ code: M, mods: MOD_CTRL | MOD_SHIFT }, name, 'win32'), 'Ctrl + Shift + M')
  assert.equal(hotkeyName({ code: M, mods: MOD_ALT | MOD_META }, name, 'darwin'), 'Option + Cmd + M')
  assert.equal(hotkeyName({ code: M, mods: MOD_META }, name, 'linux'), 'Super + M')
  assert.equal(hotkeyName({ code: MOUSE + 4, mods: 0 }, name, 'win32'), 'Mouse 4')
})

test('a hotkey fires once per press, only with exactly its modifiers', () => {
  const m = new HotkeyMatcher()
  assert.equal(m.active, false)
  m.set({ mute: { code: M, mods: MOD_CTRL }, deafen: { code: MOUSE + 5, mods: 0 } })
  assert.equal(m.active, true)
  assert.deepEqual(m.down(M, 0), [])
  assert.deepEqual(m.down(M, mods(true, true)), [])
  assert.deepEqual(m.down(D, mods(true)), [])
  assert.deepEqual(m.down(M, mods(true)), ['mute'])
  assert.deepEqual(m.down(M, mods(true)), [], 'key repeat')
  m.up(M)
  assert.deepEqual(m.down(M, mods(true)), ['mute'])
  m.up(M)
  assert.deepEqual(m.down(MOUSE + 5, 0), ['deafen'])
  m.up(MOUSE + 5)
  m.set({})
  assert.deepEqual(m.down(M, mods(true)), [])
})

test('a bare modifier works as a hotkey', () => {
  const m = new HotkeyMatcher()
  m.set({ mute: { code: CTRL, mods: 0 } })
  assert.deepEqual(m.down(CTRL, mods(true)), ['mute'])
})

test('capturing a combo', () => {
  let c = new ComboCapture()
  assert.equal(c.down(CTRL, mods(true)), null)
  assert.equal(c.down(SHIFT, mods(true, true)), null)
  assert.deepEqual(c.down(M, mods(true, true)), { code: M, mods: MOD_CTRL | MOD_SHIFT })

  c = new ComboCapture()
  assert.equal(c.down(MOUSE + 1, 0), null, 'left click ignored')
  assert.equal(c.down(MOUSE + 2, 0), null, 'right click ignored')
  assert.equal(c.up(MOUSE + 1, 0), null)
  assert.deepEqual(c.down(MOUSE + 4, mods(false, false, true)), { code: MOUSE + 4, mods: MOD_ALT })

  // A modifier pressed and released alone is the hotkey.
  c = new ComboCapture()
  assert.equal(c.down(CTRL, mods(true)), null)
  assert.deepEqual(c.up(CTRL, mods(true)), { code: CTRL, mods: 0 })

  // Escape cancels; Shift+Escape is a combo.
  assert.equal(new ComboCapture().down(ESC, 0), 'cancel')
  assert.deepEqual(new ComboCapture().down(ESC, mods(false, true)), { code: ESC, mods: MOD_SHIFT })
})

test('held modifiers: the hook flags plus modifier keys seen down', () => {
  const t = new ModifierTracker()
  assert.equal(t.update(CTRL, 0, true), MOD_CTRL, 'Ctrl down before the hook flags it')
  assert.equal(t.update(M, 0, true), MOD_CTRL)
  assert.equal(t.update(M, 0, false), MOD_CTRL)
  assert.equal(t.update(CTRL, MOD_CTRL, false), MOD_CTRL, 'the event itself still flags it')
  assert.equal(t.update(M, 0, true), 0)
  assert.equal(t.update(M, MOD_SHIFT | 64, true), MOD_SHIFT)
})

test('whisper and priority keys are held: their release is reported, once', () => {
  const m = new HotkeyMatcher()
  m.set({ whisper1: { code: MOUSE + 4, mods: 0 }, whisper2: { code: D, mods: MOD_CTRL }, priority: { code: M, mods: 0 }, mute: { code: SHIFT, mods: 0 } })
  assert.deepEqual(m.down(MOUSE + 4, 0), ['whisper1'])
  assert.deepEqual(m.down(MOUSE + 4, 0), [], 'repeat while held')
  assert.deepEqual(m.up(MOUSE + 4), ['whisper1'])
  assert.deepEqual(m.up(MOUSE + 4), [], 'released once')
  // Ctrl let go before D: D's release still ends the whisper.
  assert.deepEqual(m.down(D, mods(true)), ['whisper2'])
  assert.deepEqual(m.up(CTRL), [])
  assert.deepEqual(m.up(D), ['whisper2'])
  // A pressed (not held) hotkey reports nothing on release.
  assert.deepEqual(m.down(SHIFT, mods(false, true)), ['mute'])
  assert.deepEqual(m.up(SHIFT), [])
  // Changing the keys (or stopping the hook) releases whatever is still held.
  assert.deepEqual(m.down(M, 0), ['priority'])
  assert.deepEqual(m.release(), ['priority'])
  assert.deepEqual(m.up(M), [])
})

test('hold actions from the page are validated like the others', () => {
  assert.deepEqual(parseHotkeys({ whisper3: { code: MOUSE + 5 }, priority: { code: M, mods: MOD_ALT }, whisper4: { code: D } }),
    { whisper3: { code: MOUSE + 5, mods: 0 }, priority: { code: M, mods: MOD_ALT } })
})
