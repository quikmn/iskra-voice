// Global push-to-talk and mute/deafen hotkeys: key down/up anywhere, even while a game has focus.
// Uses libuiohook (via uiohook-napi); only the configured keys' actions are reported to the app, never other keys.
import { uIOhook, UiohookKey, type UiohookKeyboardEvent, type UiohookMouseEvent } from 'uiohook-napi'
import { ComboCapture, HotkeyMatcher, hotkeyName, isHold, ModifierTracker, modsOf, MOUSE, type HoldAction, type Hotkeys, type PressAction } from './hotkeys'
import { text } from './i18n'

// Keys are libuiohook keycodes; mouse buttons are encoded as 0x10000 + button (side buttons are popular for PTT).

const KEY_NAMES = new Map<number, string>(Object.entries(UiohookKey).map(([name, code]) => [code as number, name]))

/** A human-readable name for a key code ("V", "Ctrl", "Mouse 4"). */
export function keyName(code: number): string {
  if (code >= MOUSE) return text().keys.mouse(code - MOUSE)
  return KEY_NAMES.get(code) ?? text().keys.key(code)
}

export class PushToTalk {
  private key: number | null = null
  private down = false
  private started = false
  private listening = false
  private capture: ((code: number, mods: number, down: boolean) => void) | null = null
  private readonly hotkeys = new HotkeyMatcher()
  private readonly mods = new ModifierTracker()
  private readonly onChange: (down: boolean) => void
  private readonly onHotkey: (action: PressAction) => void
  private readonly onHold: (action: HoldAction, down: boolean) => void

  constructor(
    onChange: (down: boolean) => void, onHotkey: (action: PressAction) => void = () => undefined,
    onHold: (action: HoldAction, down: boolean) => void = () => undefined,
  ) {
    this.onChange = onChange
    this.onHotkey = onHotkey
    this.onHold = onHold
  }

  /** Starts listening (once); false if the OS refused (e.g. no Accessibility permission on macOS). */
  start(): boolean {
    if (this.started) return true
    if (!this.listening) {
      this.listening = true
      uIOhook.on('keydown', (e: UiohookKeyboardEvent) => this.press(e.keycode, this.mods.update(e.keycode, modsOf(e), true)))
      uIOhook.on('keyup', (e: UiohookKeyboardEvent) => this.release(e.keycode, this.mods.update(e.keycode, modsOf(e), false)))
      uIOhook.on('mousedown', (e: UiohookMouseEvent) => this.press(MOUSE + Number(e.button), this.mods.update(0, modsOf(e), true)))
      uIOhook.on('mouseup', (e: UiohookMouseEvent) => this.release(MOUSE + Number(e.button), this.mods.update(0, modsOf(e), false)))
    }
    try {
      uIOhook.start()
      this.started = true
    } catch (error) {
      console.error('Push-to-talk unavailable:', error)
    }
    return this.started
  }

  get running(): boolean {
    return this.started
  }

  stop(): void {
    if (this.started) uIOhook.stop()
    this.started = false
    for (const action of this.hotkeys.release()) this.onHold(action, false)
  }

  setKey(code: number | null): void {
    this.key = code
    if (this.down) {
      this.down = false
      this.onChange(false)
    }
  }

  /** Mute/deafen hotkeys (none: the hook still runs for push-to-talk, if set). */
  setHotkeys(binds: Hotkeys): void {
    for (const action of this.hotkeys.release()) this.onHold(action, false) // nothing stays held across a change
    this.hotkeys.set(binds)
  }

  get hasHotkeys(): boolean {
    return this.hotkeys.active
  }

  /** Resolves with the next key or mouse button pressed (for the "press a key" settings field); null if keys can't be seen. */
  captureNextKey(): Promise<{ code: number; name: string } | null> {
    if (!this.started) return Promise.resolve(null)
    this.cancelCapture()
    return new Promise((resolve) => {
      this.capture = (code, _mods, down) => {
        // Left and right mouse buttons would make PTT unusable; ignore them while capturing.
        if (!down || code === MOUSE + 1 || code === MOUSE + 2) return
        this.capture = null
        resolve(code < 0 ? null : { code, name: keyName(code) })
      }
    })
  }

  /** Like captureNextKey, with Ctrl/Shift/Alt/Meta held as part of it (mute/deafen hotkeys). Escape cancels. */
  captureNextHotkey(platform: NodeJS.Platform): Promise<{ code: number; mods: number; name: string } | null> {
    if (!this.started) return Promise.resolve(null)
    this.cancelCapture()
    const combo = new ComboCapture()
    return new Promise((resolve) => {
      this.capture = (code, mods, down) => {
        const result = code < 0 ? 'cancel' : down ? combo.down(code, mods) : combo.up(code, mods)
        if (!result) return
        this.capture = null
        resolve(result === 'cancel' ? null : { ...result, name: hotkeyName(result, keyName, platform) })
      }
    })
  }

  /** Ends a pending capture with null. */
  cancelCapture(): void {
    this.capture?.(-1, 0, true)
  }

  private press(code: number, mods: number): void {
    if (this.capture) {
      this.capture(code, mods, true)
      return
    }
    for (const action of this.hotkeys.down(code, mods)) {
      if (isHold(action)) this.onHold(action, true)
      else this.onHotkey(action)
    }
    if (code === this.key && !this.down) {
      this.down = true
      this.onChange(true)
    }
  }

  private release(code: number, mods: number): void {
    for (const action of this.hotkeys.up(code)) this.onHold(action, false)
    if (this.capture) {
      this.capture(code, mods, false)
      return
    }
    if (code === this.key && this.down) {
      this.down = false
      this.onChange(false)
    }
  }
}
