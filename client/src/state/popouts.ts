// Pop-outs and picture-in-picture: the voice/call panel, a stream or a text channel in a small window of its own.
// The window is only a document: this page renders into it (ui/popout/PopoutLayer.tsx, React portals), so there's
// one app, one server connection and one LiveKit room, and videos show the same MediaStreamTracks.
// Desktop app: window.open(popout.html) with a name the shell recognises (desktop/src/popouts.ts); always on top and
// click-through go through the bridge. Browsers: Document Picture-in-Picture (Chromium), else a <video>'s own
// picture-in-picture for streams (ui/VoiceStage.tsx).
import { create } from 'zustand'
import { desktop } from '../platform/desktop'
import { native } from '../platform/native'
import { PIP_SIZE, popoutMode, popoutName, stalePopouts, targetKey, type PopoutEnv, type PopoutKind, type PopoutMode, type PopoutTarget } from './popoutLogic'
import { useApp } from './store'
import { useVoice } from './voice'

export type { PopoutTarget, PopoutKind } from './popoutLogic'

export interface Popout {
  id: string
  target: PopoutTarget
  mode: Exclude<PopoutMode, 'video'>
  /** Desktop windows: shown above other windows. */
  alwaysOnTop: boolean
  /** Desktop voice panel: clicks go through to whatever is below (a game). */
  clickThrough: boolean
}

export const usePopouts = create<{ open: Popout[] }>(() => ({ open: [] }))

interface Frame {
  win: Window
  root: HTMLElement
  dispose: () => void
}
const frames = new Map<string, Frame>()
const opening = new Set<string>()
let counter = 0

/** Where the pop-out's content renders (its document's body), once it's open. */
export const popoutRoot = (id: string): HTMLElement | null => frames.get(id)?.root ?? null
export const popoutWindow = (id: string): Window | null => frames.get(id)?.win ?? null

type DocumentPip = { requestWindow(options: { width: number; height: number }): Promise<Window>; window: Window | null }
const documentPip = (): DocumentPip | undefined => (globalThis as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture

export function popoutEnv(): PopoutEnv {
  return {
    desktopWindows: !!desktop?.popout,
    documentPip: !!documentPip(),
    videoPip: typeof document !== 'undefined' && !!document.pictureInPictureEnabled,
    phoneApp: !!native,
  }
}

/** How a pop-out of this kind opens here; null hides its button. */
export const popoutModeFor = (kind: PopoutKind): PopoutMode | null => popoutMode(kind, popoutEnv())

export const findPopout = (target: PopoutTarget): Popout | undefined =>
  usePopouts.getState().open.find((p) => targetKey(p.target) === targetKey(target))

/** True when this is popped out (or on its way). */
export function usePoppedOut(target: PopoutTarget): boolean {
  const key = targetKey(target)
  return usePopouts((s) => s.open.some((p) => targetKey(p.target) === key))
}

/**
 * Pops it out (a window, or the browser's picture-in-picture window). Call it straight from a click: browsers only
 * open picture-in-picture for one. Resolves false if it couldn't open.
 */
export async function popOut(target: PopoutTarget): Promise<boolean> {
  const key = targetKey(target)
  if (findPopout(target) || opening.has(key)) return true
  const mode = popoutModeFor(target.kind)
  if (mode !== 'window' && mode !== 'document') return false
  opening.add(key)
  try {
    const name = popoutName(target.kind, ++counter)
    const win = mode === 'window' ? await openWindow(name) : await openPip(target.kind)
    if (!win) return false
    const id = mode === 'window' ? name : `pip-${counter}`
    // The browser has one picture-in-picture window: a new one replaced the old.
    if (mode === 'document') for (const p of usePopouts.getState().open) if (p.mode === 'document') drop(p.id)
    frames.set(id, { win, root: prepare(win), dispose: watchClose(win, () => drop(id)) })
    const flags = mode === 'window' ? await desktop?.popout?.set(id, {}).catch(() => null) : null
    usePopouts.setState((s) => ({ open: [...s.open, { id, target, mode, alwaysOnTop: flags?.alwaysOnTop ?? mode === 'document', clickThrough: false }] }))
    return true
  } catch {
    return false
  } finally {
    opening.delete(key)
  }
}

/** Pop back in: the window closes, and the main window shows it as before. */
export function popIn(id: string): void {
  drop(id)
}

export async function togglePopout(target: PopoutTarget): Promise<void> {
  const open = findPopout(target)
  if (open) popIn(open.id)
  else await popOut(target)
}

/** Desktop windows: always on top, click-through. */
export async function setPopoutFlags(id: string, patch: { alwaysOnTop?: boolean; clickThrough?: boolean }): Promise<void> {
  const flags = await desktop?.popout?.set(id, patch).catch(() => null)
  if (!flags) return
  usePopouts.setState((s) => ({ open: s.open.map((p) => (p.id === id ? { ...p, ...flags } : p)) }))
}

/** Click-through is on and the pointer is over (or left) the handle: the window takes clicks only meanwhile. */
export function popoutHandle(id: string, over: boolean): void {
  void desktop?.popout?.set(id, { handle: over }).catch(() => null)
}

function drop(id: string): void {
  const frame = frames.get(id)
  frames.delete(id)
  usePopouts.setState((s) => ({ open: s.open.filter((p) => p.id !== id) }))
  if (!frame) return
  frame.dispose()
  try {
    if (!frame.win.closed) frame.win.close()
  } catch {
    // Already gone.
  }
}

/** The shell's window for popout.html, once its document is there to render into. */
async function openWindow(name: string): Promise<Window | null> {
  const win = window.open(new URL('/popout.html', location.href).href, name)
  if (!win) return null
  for (let i = 0; i < 200; i++) {
    try {
      if (win.closed) return null
      if (win.location.pathname === '/popout.html' && win.document.readyState === 'complete' && win.document.body) return win
    } catch {
      // Not ours to look into yet (still about:blank, or navigating).
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  win.close()
  return null
}

async function openPip(kind: PopoutKind): Promise<Window | null> {
  const pip = documentPip()
  return pip ? pip.requestWindow(PIP_SIZE[kind]) : null
}

/** The pop-out's document looks like the app: the same stylesheets and theme, kept in step while it's open. */
function prepare(win: Window): HTMLElement {
  const doc = win.document
  const copies = new Map<Node, Element>()
  const copy = (node: Node) => {
    if (!(node instanceof HTMLElement) || copies.has(node)) return
    const sheet = node.tagName === 'STYLE' || (node.tagName === 'LINK' && (node as HTMLLinkElement).rel === 'stylesheet')
    if (!sheet) return
    const clone = doc.importNode(node, true) as Element
    // A picture-in-picture document is about:blank: links need their full address.
    if (node.tagName === 'LINK') clone.setAttribute('href', (node as HTMLLinkElement).href)
    doc.head.append(clone)
    copies.set(node, clone)
  }
  document.head.querySelectorAll('link[rel="stylesheet"], style').forEach(copy)
  const mirrorRoot = () => {
    for (const { name, value } of [...document.documentElement.attributes]) doc.documentElement.setAttribute(name, value)
  }
  mirrorRoot()
  // Stylesheets that load later (lazy parts of the app, the dev server's updates) and theme changes follow.
  const heads = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach(copy)
      r.removedNodes.forEach((n) => {
        copies.get(n)?.remove()
        copies.delete(n)
      })
      const style = r.target instanceof Text ? r.target.parentNode : null
      if (style && copies.has(style)) copies.get(style)!.textContent = style.textContent
    }
  })
  heads.observe(document.head, { childList: true, subtree: true, characterData: true })
  const roots = new MutationObserver(mirrorRoot)
  roots.observe(document.documentElement, { attributes: true })
  win.addEventListener('pagehide', () => {
    heads.disconnect()
    roots.disconnect()
  })
  doc.body.className = 'popout-body'
  const root = doc.createElement('div')
  root.className = 'popout-root'
  doc.body.replaceChildren(root)
  return root
}

/** Closed by the window's own close button, Alt+F4 or the browser: noticed either way. */
function watchClose(win: Window, closed: () => void): () => void {
  win.addEventListener('pagehide', closed)
  const poll = setInterval(() => win.closed && closed(), 1000)
  return () => {
    clearInterval(poll)
    try {
      win.removeEventListener('pagehide', closed)
    } catch {
      // Gone.
    }
  }
}

/** Pop-outs close with their call, stream or channel, and with this page. Returns a stop. */
export function startPopouts(): () => void {
  const check = () => {
    const open = usePopouts.getState().open
    if (!open.length) return
    const { session, tiles } = useVoice.getState()
    const { servers } = useApp.getState()
    const stale = stalePopouts(open, {
      inVoice: !!session,
      tileIds: new Set(tiles.map((t) => t.id)),
      channelExists: (serverKey, channelId) => !!servers[serverKey]?.channels.some((c) => c.id === channelId),
    })
    for (const id of stale) drop(id)
  }
  const stops = [useVoice.subscribe(check), useApp.subscribe(check), usePopouts.subscribe(check)]
  const closeAll = () => {
    for (const p of usePopouts.getState().open) drop(p.id)
  }
  window.addEventListener('pagehide', closeAll)
  return () => {
    for (const stop of stops) stop()
    window.removeEventListener('pagehide', closeAll)
    closeAll()
  }
}
