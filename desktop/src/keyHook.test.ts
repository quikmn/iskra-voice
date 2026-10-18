// PushToTalk on the events libuiohook sends (the real hook's code path, without the native hook), and the e2e hook.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MOD_CTRL, MOUSE, type HoldAction, type PressAction } from './hotkeys'
import { PushToTalk, TestKeyHook, type HookKeyEvent, type HookMouseEvent, type KeyHook } from './keyHook'

const CTRL = 0x1d
const F23 = 0x6a
const F24 = 0x6b
const V = 0x2f
const name = (code: number) => (code >= MOUSE ? `Mouse ${code - MOUSE}` : ({ [CTRL]: 'Ctrl', [F23]: 'F23', [F24]: 'F24', [V]: 'V' } as Record<number, string>)[code] ?? `Key ${code}`)
const flags = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }

/** uIOhook as the OS drives it: raw keydown/keyup/mousedown/mouseup events. */
class RawHook implements KeyHook {
  readonly handlers = new Map<string, ((e: never) => void)[]>()
  started = 0
  stopped = 0
  failStart = false
  on(event: string, listener: (e: never) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
  }
  start(): void {
    if (this.failStart) throw new Error('no hook')
    this.started++
  }
  stop(): void {
    this.stopped++
  }
  emit(event: 'keydown' | 'keyup', e: HookKeyEvent): void
  emit(event: 'mousedown' | 'mouseup', e: HookMouseEvent): void
  emit(event: string, e: HookKeyEvent | HookMouseEvent): void {
    for (const h of this.handlers.get(event) ?? []) (h as (e: HookKeyEvent | HookMouseEvent) => void)(e)
  }
}

function setup(hook: KeyHook) {
  const ptt: boolean[] = []
  const pressed: PressAction[] = []
  const held: [HoldAction, boolean][] = []
  const p = new PushToTalk(hook, name, (d) => ptt.push(d), (a) => pressed.push(a), (a, d) => held.push([a, d]))
  return { p, ptt, pressed, held }
}

test('push-to-talk follows the key and mouse button events from the hook', async () => {
  const raw = new RawHook()
  const { p, ptt } = setup(raw)
  assert.equal(await p.captureNextKey(), null) // nothing seen before the hook runs
  assert.equal(p.start(), true)
  assert.equal(p.start(), true)
  assert.equal(raw.started, 1)
  assert.equal(raw.handlers.get('keydown')?.length, 1) // listeners added once
  p.setKey(V)
  raw.emit('keydown', { keycode: V, ...flags })
  raw.emit('keydown', { keycode: V, ...flags }) // key repeat: still one "down"
  raw.emit('keyup', { keycode: V, ...flags })
  assert.deepEqual(ptt, [true, false])
  // A mouse side button as the key; left and right are never captured.
  const next = p.captureNextKey()
  raw.emit('mousedown', { button: 1, ...flags })
  raw.emit('mousedown', { button: 4, ...flags })
  assert.deepEqual(await next, { code: MOUSE + 4, name: 'Mouse 4' })
  p.setKey(MOUSE + 4)
  raw.emit('mousedown', { button: 4, ...flags })
  raw.emit('mouseup', { button: 4, ...flags })
  assert.deepEqual(ptt, [true, false, true, false])
  p.stop()
  assert.equal(raw.stopped, 1)
  assert.equal(p.running, false)

  const broken = new RawHook()
  broken.failStart = true
  const original = console.error
  console.error = () => undefined
  try {
    assert.equal(setup(broken).p.start(), false)
  } finally {
    console.error = original
  }
})

test('mute hotkey: Ctrl+F24 set by pressing it, then only that combo reports "mute"', async () => {
  const raw = new RawHook()
  const { p, pressed } = setup(raw)
  p.start()
  const capture = p.captureNextHotkey('win32')
  raw.emit('keydown', { keycode: CTRL, ...flags, ctrlKey: true })
  raw.emit('keydown', { keycode: F24, ...flags, ctrlKey: true })
  raw.emit('keyup', { keycode: F24, ...flags, ctrlKey: true })
  raw.emit('keyup', { keycode: CTRL, ...flags })
  const got = await capture
  assert.deepEqual(got, { code: F24, mods: MOD_CTRL, name: 'Ctrl + F24' })
  p.setHotkeys({ mute: { code: F24, mods: MOD_CTRL } })
  raw.emit('keydown', { keycode: F24, ...flags }) // without Ctrl
  raw.emit('keyup', { keycode: F24, ...flags })
  raw.emit('keydown', { keycode: F23, ...flags, ctrlKey: true })
  raw.emit('keyup', { keycode: F23, ...flags, ctrlKey: true })
  assert.deepEqual(pressed, [])
  raw.emit('keydown', { keycode: F24, ...flags, ctrlKey: true })
  assert.deepEqual(pressed, ['mute'])
})

test('the e2e hook never listens to the OS: taps reach PushToTalk like keyTap, only while it runs', async () => {
  const hook = new TestKeyHook()
  const { p, pressed } = setup(hook)
  p.setHotkeys({ mute: { code: F24, mods: MOD_CTRL } })
  hook.tap(F24, [CTRL]) // not started yet: nothing
  assert.deepEqual(pressed, [])
  p.start()
  const capture = p.captureNextHotkey('win32')
  hook.tap(F24, [CTRL])
  assert.deepEqual(await capture, { code: F24, mods: MOD_CTRL, name: 'Ctrl + F24' })
  hook.tap(F23, [CTRL])
  hook.tap(F24)
  hook.tap(F24, [CTRL])
  assert.deepEqual(pressed, ['mute'])
  p.stop()
  hook.tap(F24, [CTRL])
  assert.deepEqual(pressed, ['mute'])
})
