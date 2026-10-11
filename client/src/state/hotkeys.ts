// Mute, deafen and clip hotkeys. Desktop: global (they work while a game has focus), seen by the desktop shell, which only
// ever tells us which action fired. Browser: in-app shortcuts while Iskra is the focused tab.
import { create } from 'zustand'
import { desktop } from '../platform/desktop'
import { toggleDeafen, toggleMute, useVoice } from './voice'

export type HotkeyAction = 'mute' | 'deafen' | 'clip'
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ['mute', 'deafen', 'clip']

/** Browser: a KeyboardEvent.code plus the modifiers held with it. */
export interface WebHotkey {
  code: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  label: string
}

/** Desktop: a libuiohook key code or mouse button (0x10000 + button), mods as Ctrl 1, Shift 2, Alt 4, Meta 8. */
export interface DesktopHotkey {
  code: number
  mods: number
  label: string
}

interface HotkeyState {
  web: Partial<Record<HotkeyAction, WebHotkey>>
  desktop: Partial<Record<HotkeyAction, DesktopHotkey>>
}

const KEY = 'iskra.hotkeys'
const DESKTOP_CTRL = 1
const DESKTOP_ALT = 4
const DESKTOP_META = 8

const isWebHotkey = (h: unknown): h is WebHotkey => {
  const v = h as WebHotkey
  return !!v && typeof v === 'object' && typeof v.code === 'string' && v.code.length <= 40 && typeof v.label === 'string' &&
    [v.ctrl, v.shift, v.alt, v.meta].every((b) => typeof b === 'boolean')
}
const isDesktopHotkey = (h: unknown): h is DesktopHotkey => {
  const v = h as DesktopHotkey
  return !!v && typeof v === 'object' && Number.isInteger(v.code) && Number.isInteger(v.mods) && typeof v.label === 'string'
}

/** Stored hotkeys, keeping only well-formed ones. */
export function parseHotkeys(raw: string | null): HotkeyState {
  const state: HotkeyState = { web: {}, desktop: {} }
  let data: { web?: Record<string, unknown>; desktop?: Record<string, unknown> }
  try {
    data = JSON.parse(raw ?? '{}') ?? {}
  } catch {
    return state
  }
  for (const action of HOTKEY_ACTIONS) {
    const web = data.web?.[action]
    const desk = data.desktop?.[action]
    if (isWebHotkey(web)) state.web[action] = web
    if (isDesktopHotkey(desk)) state.desktop[action] = desk
  }
  return state
}

function load(): HotkeyState {
  try {
    return parseHotkeys(localStorage.getItem(KEY))
  } catch {
    return { web: {}, desktop: {} }
  }
}

export const useHotkeys = create<HotkeyState>(load)

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(useHotkeys.getState()))
  } catch {
    /* private mode: this session only */
  }
}

/** What the desktop shell listens for (codes and modifiers only). */
function sendToDesktop(): void {
  const binds = useHotkeys.getState().desktop
  void desktop?.setHotkeys?.(Object.fromEntries(HOTKEY_ACTIONS.flatMap((a) => (binds[a] ? [[a, { code: binds[a].code, mods: binds[a].mods }]] : []))))
}

/** Whether the desktop shell can do global hotkeys (an up-to-date desktop app). */
export const globalHotkeys = (): boolean => !!desktop?.setHotkeys && !!desktop.captureHotkey && !!desktop.onHotkey

const sameWeb = (a: WebHotkey, b: WebHotkey) => a.code === b.code && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta

/** Sets (or clears, with null) a hotkey. The same key on the other action is cleared, so one press does one thing. */
export function setWebHotkey(action: HotkeyAction, hotkey: WebHotkey | null): void {
  const web = { ...useHotkeys.getState().web }
  if (hotkey) for (const other of HOTKEY_ACTIONS) if (other !== action && web[other] && sameWeb(web[other], hotkey)) delete web[other]
  if (hotkey) web[action] = hotkey
  else delete web[action]
  useHotkeys.setState({ web })
  save()
}

export function setDesktopHotkey(action: HotkeyAction, hotkey: DesktopHotkey | null): void {
  const binds = { ...useHotkeys.getState().desktop }
  if (hotkey) {
    for (const other of HOTKEY_ACTIONS) {
      const h = binds[other]
      if (other !== action && h && h.code === hotkey.code && h.mods === hotkey.mods) delete binds[other]
    }
    binds[action] = hotkey
  } else delete binds[action]
  useHotkeys.setState({ desktop: binds })
  save()
  sendToDesktop()
}

// ── Browser keys ──────────────────────────────────────────────────────────

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'])

type KeyLike = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

const mac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** "M", "F5", "Num 1", "Space". */
export function webKeyName(code: string, key: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`
  if (/^F\d{1,2}$/.test(code)) return code
  if (code.startsWith('Arrow')) return code.slice(5)
  if (key.length === 1 && key.trim()) return key.toUpperCase()
  return code || key
}

export function webHotkeyLabel(h: Omit<WebHotkey, 'label'>, key: string, onMac = mac()): string {
  const parts: string[] = []
  if (h.ctrl) parts.push('Ctrl')
  if (h.alt) parts.push(onMac ? 'Option' : 'Alt')
  if (h.shift) parts.push('Shift')
  if (h.meta) parts.push(onMac ? 'Cmd' : 'Meta')
  parts.push(webKeyName(h.code, key))
  return parts.join(' + ')
}

/** The hotkey a key press makes in the "press a key" field: null for a lone modifier (keep waiting), 'cancel' for Escape. */
export function webHotkeyFrom(e: KeyLike, onMac = mac()): WebHotkey | 'cancel' | null {
  if (MODIFIER_CODES.has(e.code) || !e.code) return null
  if (e.code === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return 'cancel'
  const h = { code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
  return { ...h, label: webHotkeyLabel(h, e.key, onMac) }
}

export const matchesWebHotkey = (e: KeyLike, h: WebHotkey): boolean =>
  e.code === h.code && e.ctrlKey === h.ctrl && e.shiftKey === h.shift && e.altKey === h.alt && e.metaKey === h.meta

/** Typing into a field in Iskra. */
export const isTypingTarget = (target: EventTarget | null): boolean =>
  typeof HTMLElement !== 'undefined' && target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/**
 * A hotkey that would type a character (no Ctrl, Alt or Cmd held) doesn't fire while you type in Iskra.
 * Ctrl/Alt/Cmd combos and mouse buttons always do, like in other voice apps.
 */
export const typesText = (h: { ctrl: boolean; alt: boolean; meta: boolean }): boolean => !h.ctrl && !h.alt && !h.meta

export const desktopTypesText = (h: DesktopHotkey): boolean =>
  h.code < 0x10000 && typesText({ ctrl: !!(h.mods & DESKTOP_CTRL), alt: !!(h.mods & DESKTOP_ALT), meta: !!(h.mods & DESKTOP_META) })

// ── Running them ──────────────────────────────────────────────────────────

let clipHandler: () => void = () => {}
/** What the clip hotkey does (state/clips.ts sets it, so this file stays light). */
export const onClipHotkey = (handler: () => void): void => {
  clipHandler = handler
}

/** Mute, deafen or save a clip in whatever voice session is on (channel, DM call, group call, stage). */
export function runHotkey(action: HotkeyAction): void {
  const { session } = useVoice.getState()
  if (!session) return
  if (action === 'clip') clipHandler()
  else if (action === 'mute') {
    // Stage listeners have no mic to mute.
    if (session.canSpeak) void toggleMute()
  } else void toggleDeafen()
}

/** Wires the hotkeys: global on desktop, in-page in the browser. */
export function startHotkeys(): () => void {
  if (globalHotkeys()) {
    sendToDesktop()
    return desktop!.onHotkey!((action) => {
      const hotkey = useHotkeys.getState().desktop[action]
      if (hotkey && desktopTypesText(hotkey) && document.hasFocus() && isTypingTarget(document.activeElement)) return
      runHotkey(action)
    })
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || e.defaultPrevented || capturing) return
    const { web } = useHotkeys.getState()
    for (const action of HOTKEY_ACTIONS) {
      const hotkey = web[action]
      if (!hotkey || !matchesWebHotkey(e, hotkey)) continue
      if (typesText(hotkey) && isTypingTarget(e.target)) return
      e.preventDefault()
      runHotkey(action)
      return
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}

/** While the settings field waits for a key, hotkeys don't fire. */
let capturing = false

/** Browser: the next key combo pressed in the page (null if cancelled with Escape or `signal`). */
export function captureWebHotkey(signal?: AbortSignal): Promise<WebHotkey | null> {
  capturing = true
  return new Promise((resolve) => {
    const done = (result: WebHotkey | null) => {
      capturing = false
      window.removeEventListener('keydown', onKey, true)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const result = webHotkeyFrom(e)
      if (result) done(result === 'cancel' ? null : result)
    }
    const onAbort = () => done(null)
    window.addEventListener('keydown', onKey, true)
    signal?.addEventListener('abort', onAbort)
  })
}
