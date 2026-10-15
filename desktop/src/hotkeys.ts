// Global mute/deafen hotkeys: a key or mouse button, optionally with Ctrl/Shift/Alt/Meta held.
// Pure logic (no key hook here) so it can be unit-tested; ptt.ts feeds it libuiohook's events.

/** Keys are libuiohook keycodes; mouse buttons are 0x10000 + button (as in ptt.ts). */
export const MOUSE = 0x10000
export const MOD_CTRL = 1
export const MOD_SHIFT = 2
export const MOD_ALT = 4
export const MOD_META = 8
const ALL_MODS = MOD_CTRL | MOD_SHIFT | MOD_ALT | MOD_META

/** libuiohook's codes for the modifier keys (UiohookKey.Ctrl, CtrlRight, ...). */
const MODIFIER_KEYS = new Map<number, number>([
  [29, MOD_CTRL], [3613, MOD_CTRL],
  [42, MOD_SHIFT], [54, MOD_SHIFT],
  [56, MOD_ALT], [3640, MOD_ALT],
  [3675, MOD_META], [3676, MOD_META],
])
const ESCAPE = 1

export type PressAction = 'mute' | 'deafen' | 'clip'
/** Held, not pressed: the page hears when they go down and when they come up (whisper lists 1–3, priority speaker). */
export type HoldAction = 'whisper1' | 'whisper2' | 'whisper3' | 'priority'
export type HotkeyAction = PressAction | HoldAction
export const HOLD_ACTIONS: readonly HoldAction[] = ['whisper1', 'whisper2', 'whisper3', 'priority']
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ['mute', 'deafen', 'clip', ...HOLD_ACTIONS]
export const isHold = (action: HotkeyAction): action is HoldAction => (HOLD_ACTIONS as readonly string[]).includes(action)

export interface Hotkey {
  code: number
  mods: number
}
export type Hotkeys = Partial<Record<HotkeyAction, Hotkey>>

export interface ModifierState {
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export const modsOf = (e: ModifierState): number =>
  (e.ctrlKey ? MOD_CTRL : 0) | (e.shiftKey ? MOD_SHIFT : 0) | (e.altKey ? MOD_ALT : 0) | (e.metaKey ? MOD_META : 0)

/** The modifier bit a key itself sets (0 for ordinary keys and mouse buttons). */
export const modifierBit = (code: number): number => MODIFIER_KEYS.get(code) ?? 0

/** Modifiers held besides the key itself (pressing Ctrl reports Ctrl as held, which isn't a combo). */
const otherMods = (code: number, mods: number) => mods & ALL_MODS & ~modifierBit(code)

const validCode = (code: unknown): code is number => typeof code === 'number' && Number.isInteger(code) && code > 0 && code < MOUSE + 32

/** Hotkeys from the page: anything malformed is dropped. */
export function parseHotkeys(raw: unknown): Hotkeys {
  const out: Hotkeys = {}
  if (!raw || typeof raw !== 'object') return out
  for (const action of HOTKEY_ACTIONS) {
    const h = (raw as Record<string, unknown>)[action] as { code?: unknown; mods?: unknown } | null | undefined
    if (!h || typeof h !== 'object' || !validCode(h.code)) continue
    const mods = typeof h.mods === 'number' && Number.isInteger(h.mods) ? h.mods & ALL_MODS : 0
    out[action] = { code: h.code, mods: otherMods(h.code, mods) }
  }
  return out
}

/** "Ctrl + Shift + M", "Mouse 4". `keyName` names a bare key or button. */
export function hotkeyName(h: Hotkey, keyName: (code: number) => string, platform: NodeJS.Platform): string {
  const mac = platform === 'darwin'
  const parts: string[] = []
  if (h.mods & MOD_CTRL) parts.push('Ctrl')
  if (h.mods & MOD_ALT) parts.push(mac ? 'Option' : 'Alt')
  if (h.mods & MOD_SHIFT) parts.push('Shift')
  if (h.mods & MOD_META) parts.push(mac ? 'Cmd' : platform === 'win32' ? 'Win' : 'Super')
  parts.push(keyName(h.code))
  return parts.join(' + ')
}

/**
 * Which modifiers are held: libuiohook's own flags, plus the modifier keys we saw go down and not up yet
 * (its flags can lag behind, e.g. for keys pressed just after the hook started).
 */
export class ModifierTracker {
  private held = 0

  /** Feed every key event; returns the modifiers held for it. */
  update(code: number, flags: number, down: boolean): number {
    const bit = modifierBit(code)
    if (bit && down) this.held |= bit
    else if (bit) this.held &= ~bit
    return (flags | this.held) & ALL_MODS
  }
}

/** Fires each hotkey once per press (keys auto-repeat while held); hold actions also report their release. */
export class HotkeyMatcher {
  private binds: Hotkeys = {}
  private readonly held = new Set<number>()
  /** Hold actions down right now, by the key that started them. */
  private readonly holding = new Map<number, HoldAction[]>()

  set(binds: Hotkeys): void {
    this.binds = binds
    this.held.clear()
    this.holding.clear()
  }

  /** Hold actions still down (to release them when the keys change or the hook stops). */
  release(): HoldAction[] {
    const all = [...this.holding.values()].flat()
    this.holding.clear()
    this.held.clear()
    return all
  }

  get active(): boolean {
    return HOTKEY_ACTIONS.some((a) => this.binds[a])
  }

  /** The actions a press triggers (usually none). */
  down(code: number, mods: number): HotkeyAction[] {
    if (this.held.has(code)) return []
    const hit = HOTKEY_ACTIONS.filter((a) => {
      const h = this.binds[a]
      return h && h.code === code && h.mods === otherMods(code, mods)
    })
    if (hit.length) this.held.add(code)
    const holds = hit.filter(isHold)
    if (holds.length) this.holding.set(code, holds)
    return hit
  }

  /** The hold actions this key's release ends (usually none). */
  up(code: number): HoldAction[] {
    this.held.delete(code)
    const released = this.holding.get(code) ?? []
    this.holding.delete(code)
    return released
  }
}

/**
 * "Press a key" for a hotkey: the first key or side button, with whatever modifiers are held.
 * A modifier pressed and released on its own becomes the hotkey itself. Escape cancels.
 */
export class ComboCapture {
  private modifier: number | null = null

  /** A finished hotkey, 'cancel', or null to keep waiting. */
  down(code: number, mods: number): Hotkey | 'cancel' | null {
    if (modifierBit(code)) {
      this.modifier = code
      return null
    }
    this.modifier = null
    // Left and right mouse buttons would fire on every click.
    if (code === MOUSE + 1 || code === MOUSE + 2) return null
    if (code === ESCAPE && otherMods(code, mods) === 0) return 'cancel'
    return { code, mods: otherMods(code, mods) }
  }

  up(code: number, mods: number): Hotkey | null {
    if (code !== this.modifier) return null
    this.modifier = null
    return { code, mods: otherMods(code, mods) }
  }
}
