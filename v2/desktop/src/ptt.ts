// Global push-to-talk: key down/up anywhere, even while a game has focus.
// Uses libuiohook (via uiohook-napi); only the configured key is reported to the app.
import { uIOhook, UiohookKey, type UiohookKeyboardEvent, type UiohookMouseEvent } from 'uiohook-napi'

/** Keys are libuiohook keycodes; mouse buttons are encoded as 0x10000 + button (side buttons are popular for PTT). */
const MOUSE = 0x10000

const KEY_NAMES = new Map<number, string>(Object.entries(UiohookKey).map(([name, code]) => [code as number, name]))

/** A human-readable name for a key code ("V", "Ctrl", "Mouse 4"). */
export function keyName(code: number): string {
  if (code >= MOUSE) return `Mouse ${code - MOUSE}`
  return KEY_NAMES.get(code) ?? `Key ${code}`
}

export class PushToTalk {
  private key: number | null = null
  private down = false
  private started = false
  private capture: ((code: number) => void) | null = null
  private readonly onChange: (down: boolean) => void

  constructor(onChange: (down: boolean) => void) {
    this.onChange = onChange
  }

  start(): void {
    if (this.started) return
    uIOhook.on('keydown', (e: UiohookKeyboardEvent) => this.press(e.keycode))
    uIOhook.on('keyup', (e: UiohookKeyboardEvent) => this.release(e.keycode))
    uIOhook.on('mousedown', (e: UiohookMouseEvent) => this.press(MOUSE + Number(e.button)))
    uIOhook.on('mouseup', (e: UiohookMouseEvent) => this.release(MOUSE + Number(e.button)))
    try {
      uIOhook.start()
      this.started = true
    } catch (error) {
      console.error('Push-to-talk unavailable:', error)
    }
  }

  stop(): void {
    if (this.started) uIOhook.stop()
    this.started = false
  }

  setKey(code: number | null): void {
    this.key = code
    if (this.down) {
      this.down = false
      this.onChange(false)
    }
  }

  /** Resolves with the next key or mouse button pressed (for the "press a key" settings field). */
  captureNextKey(): Promise<{ code: number; name: string }> {
    return new Promise((resolve) => {
      this.capture = (code) => resolve({ code, name: keyName(code) })
    })
  }

  private press(code: number): void {
    if (this.capture) {
      // Left and right mouse buttons would make PTT unusable; ignore them while capturing.
      if (code === MOUSE + 1 || code === MOUSE + 2) return
      const done = this.capture
      this.capture = null
      done(code)
      return
    }
    if (code === this.key && !this.down) {
      this.down = true
      this.onChange(true)
    }
  }

  private release(code: number): void {
    if (code === this.key && this.down) {
      this.down = false
      this.onChange(false)
    }
  }
}
