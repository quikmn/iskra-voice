// Global push-to-talk and mute/deafen hotkeys: key down/up anywhere, even while a game has focus.
// The key hook is libuiohook (uiohook-napi, wired in ptt.ts); this file has no native code, so the unit tests drive
// PushToTalk with the same events the hook sends, and e2e runs get TestKeyHook instead of the real hook (a key pressed
// on the PC during a run never lands in a test). Only the configured keys' actions are reported, never other keys.
import { ComboCapture, HotkeyMatcher, hotkeyName, isHold, modifierBit, ModifierTracker, modsOf, MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, MOUSE, type HoldAction, type Hotkeys, type ModifierState, type PressAction } from './hotkeys'

/** What uiohook-napi sends (the parts used here). */
export interface HookKeyEvent extends ModifierState { keycode: number }
export interface HookMouseEvent extends ModifierState { button: unknown }

/** uIOhook's shape: listeners for key and mouse buttons, start and stop. */
export interface KeyHook {
  on(event: 'keydown' | 'keyup', listener: (e: HookKeyEvent) => void): unknown
  on(event: 'mousedown' | 'mouseup', listener: (e: HookMouseEvent) => void): unknown
  start(): void
  stop(): void
}

export class PushToTalk {
  private key: number | null = null
  private down = false
  private started = false
  private listening = false
  private capture: ((code: number, mods: number, down: boolean) => void) | null = null
  private readonly hotkeys = new HotkeyMatcher()
  private readonly mods = new ModifierTracker()

  constructor(
    private readonly hook: KeyHook,
    private readonly keyName: (code: number) => string,
    private readonly onChange: (down: boolean) => void,
    private readonly onHotkey: (action: PressAction) => void = () => undefined,
    private readonly onHold: (action: HoldAction, down: boolean) => void = () => undefined,
  ) {}

  /** Starts listening (once); false if the OS refused (e.g. no Accessibility permission on macOS). */
  start(): boolean {
    if (this.started) return true
    if (!this.listening) {
      this.listening = true
      this.hook.on('keydown', (e: HookKeyEvent) => this.press(e.keycode, this.mods.update(e.keycode, modsOf(e), true)))
      this.hook.on('keyup', (e: HookKeyEvent) => this.release(e.keycode, this.mods.update(e.keycode, modsOf(e), false)))
      this.hook.on('mousedown', (e: HookMouseEvent) => this.press(MOUSE + Number(e.button), this.mods.update(0, modsOf(e), true)))
      this.hook.on('mouseup', (e: HookMouseEvent) => this.release(MOUSE + Number(e.button), this.mods.update(0, modsOf(e), false)))
    }
    try {
      this.hook.start()
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
    if (this.started) this.hook.stop()
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
        resolve(code < 0 ? null : { code, name: this.keyName(code) })
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
        resolve(result === 'cancel' ? null : { ...result, name: hotkeyName(result, this.keyName, platform) })
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

/**
 * The hook e2e runs get: it never listens to the OS. The suite taps keys through it (main.ts puts it on
 * globalThis.iskraTestKeys) with the events libuiohook's keyTap makes: modifiers down, the key down and up,
 * modifiers up, each carrying the modifier flags held at that moment.
 */
export class TestKeyHook implements KeyHook {
  private readonly listeners = new Map<string, ((e: HookKeyEvent) => void)[]>()
  private running = false

  on(event: string, listener: (e: never) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener as (e: HookKeyEvent) => void])
    return this
  }

  start(): void {
    this.running = true
  }

  stop(): void {
    this.running = false
  }

  tap(code: number, modifiers: number[] = []): void {
    let held = 0
    const emit = (event: 'keydown' | 'keyup', keycode: number) => {
      if (!this.running) return
      const e = { keycode, ctrlKey: !!(held & MOD_CTRL), shiftKey: !!(held & MOD_SHIFT), altKey: !!(held & MOD_ALT), metaKey: !!(held & MOD_META) }
      for (const listener of this.listeners.get(event) ?? []) listener(e)
    }
    for (const m of modifiers) {
      held |= modifierBit(m)
      emit('keydown', m)
    }
    emit('keydown', code)
    emit('keyup', code)
    for (const m of [...modifiers].reverse()) {
      held &= ~modifierBit(m)
      emit('keyup', m)
    }
  }
}
