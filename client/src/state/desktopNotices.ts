// The desktop shell's own messages (the tray's "Check for updates" result, About, the macOS screen-recording
// permission) arrive as structured notices (desktop/src/notices.ts) and show as the app's own toast and dialog, in
// the app's language, never as native message boxes. Just that: not a notification centre.
import { create } from 'zustand'
import { desktop } from '../platform/desktop'
import { openMySettings } from '../ui/settings/open'
import { useApp } from './store'

export type UpdateCheckResult = 'found' | 'up-to-date' | 'off' | 'failed'

export type DesktopNotice =
  /** found: `version` is downloading now; otherwise `version` is the one running. */
  | { kind: 'update-check'; result: UpdateCheckResult; version: string }
  | { kind: 'about' }
  | { kind: 'screen-permission' }

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,40})?$/
const RESULTS: readonly string[] = ['found', 'up-to-date', 'off', 'failed']

/** Only well-formed notices, whatever the shell sent. */
export function parseDesktopNotice(value: unknown): DesktopNotice | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<{ kind: unknown; result: unknown; version: unknown }>
  if (v.kind === 'about' || v.kind === 'screen-permission') return { kind: v.kind }
  if (v.kind === 'update-check' && typeof v.result === 'string' && RESULTS.includes(v.result) && typeof v.version === 'string' && VERSION.test(v.version)) {
    return { kind: 'update-check', result: v.result as UpdateCheckResult, version: v.version }
  }
  return null
}

/** What shows as a toast: an update check's result, or About before there is a settings page to open (first run). */
export type ToastNotice = Extract<DesktopNotice, { kind: 'update-check' | 'about' }>
export type DialogNotice = Extract<DesktopNotice, { kind: 'screen-permission' }>

export const useDesktopNotices = create<{ toast: { id: number; notice: ToastNotice } | null; dialog: DialogNotice | null }>(() => ({ toast: null, dialog: null }))

/** A toast goes by itself after this long, unless closed. */
export const TOAST_MS = 8000
let nextId = 1
let timer: ReturnType<typeof setTimeout> | null = null

export function showDesktopNotice(notice: DesktopNotice): void {
  if (notice.kind === 'screen-permission') return useDesktopNotices.setState({ dialog: notice })
  // About is the app's own About & legal page; before there is one (first run, app lock) a toast names the version.
  if (notice.kind === 'about' && useApp.getState().phase === 'ready') return openMySettings('about')
  const id = nextId++
  if (timer) clearTimeout(timer)
  useDesktopNotices.setState({ toast: { id, notice } })
  timer = setTimeout(() => dismissNoticeToast(id), TOAST_MS)
}

/** Closes the toast (a later one stays when an old timer fires). */
export function dismissNoticeToast(id?: number): void {
  const current = useDesktopNotices.getState().toast
  if (!current || (id !== undefined && current.id !== id)) return
  if (timer) clearTimeout(timer)
  timer = null
  useDesktopNotices.setState({ toast: null })
}

export const closeNoticeDialog = (): void => useDesktopNotices.setState({ dialog: null })

/** The dialog's button: the shell opens System Settings on the Screen Recording page. */
export function answerNoticeDialog(): void {
  void desktop?.notices?.act('screen-permission', 'open-settings').catch(() => undefined)
  closeNoticeDialog()
}

/** Listens for the shell's notices (nothing outside the desktop app). */
export function startDesktopNotices(): () => void {
  if (!desktop?.notices) return () => {}
  return desktop.notices.onNotice((value) => {
    const notice = parseDesktopNotice(value)
    if (notice) showDesktopNotice(notice)
  })
}
