// The real key hook for push-to-talk and the mute/deafen hotkeys: libuiohook (via uiohook-napi). PushToTalk itself
// (keyHook.ts) has no native code; e2e runs give it TestKeyHook instead of this.
import { uIOhook, UiohookKey } from 'uiohook-napi'
import { MOUSE, type HoldAction, type PressAction } from './hotkeys'
import { text } from './i18n'
import { PushToTalk, TestKeyHook, type KeyHook } from './keyHook'

// Keys are libuiohook keycodes; mouse buttons are encoded as 0x10000 + button (side buttons are popular for PTT).

const KEY_NAMES = new Map<number, string>(Object.entries(UiohookKey).map(([name, code]) => [code as number, name]))

/** A human-readable name for a key code ("V", "Ctrl", "Mouse 4"). */
export function keyName(code: number): string {
  if (code >= MOUSE) return text().keys.mouse(code - MOUSE)
  return KEY_NAMES.get(code) ?? text().keys.key(code)
}

/**
 * Push-to-talk on the OS-wide hook, or, in an e2e run, on TestKeyHook: the suite taps keys by name through
 * globalThis.iskraTestKeys.tap('F24', ['Ctrl']), and keys pressed on the PC meanwhile never reach the app.
 */
export function pushToTalk(
  testRun: boolean, onChange: (down: boolean) => void, onHotkey: (action: PressAction) => void,
  onHold: (action: HoldAction, down: boolean) => void,
): PushToTalk {
  let hook: KeyHook = uIOhook
  if (testRun) {
    const testHook = new TestKeyHook()
    const code = (name: string) => {
      const c = (UiohookKey as Record<string, number>)[name]
      if (typeof c !== 'number') throw new Error(`no key named ${name}`)
      return c
    }
    ;(globalThis as { iskraTestKeys?: unknown }).iskraTestKeys = { tap: (key: string, mods: string[] = []) => testHook.tap(code(key), mods.map(code)) }
    hook = testHook
  }
  return new PushToTalk(hook, keyName, onChange, onHotkey, onHold)
}
