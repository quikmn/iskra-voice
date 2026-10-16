// The shell's own messages to the person (the tray's "Check for updates" result, About, the macOS screen-recording
// permission) go to the app's page as structured notices, never as native message boxes: the page puts them into
// words in its own language and shows them as its toasts and dialogs (client/src/state/desktopNotices.ts). A button
// in such a dialog comes back as an action. Kept free of Electron imports so it can be unit-tested anywhere.
import type { UpdateState } from './platform'
import type { CheckResult } from './updates'

export type DesktopNotice =
  /** found: `version` is downloading now; otherwise `version` is the one running. */
  | { kind: 'update-check'; result: CheckResult; version: string }
  | { kind: 'about' }
  | { kind: 'screen-permission' }

/** What the tray's "Check for updates" tells the page (the found-and-ready and found-but-manual cases never get here). */
export function updateCheckNotice(result: CheckResult, status: UpdateState, appVersion: string): DesktopNotice {
  const version = result === 'found' && 'version' in status ? status.version : appVersion
  return { kind: 'update-check', result, version }
}

/** The replies a notice can have: a button the page showed for it. */
export type NoticeAction = { kind: 'screen-permission'; action: 'open-settings' } | { kind: 'about'; action: 'licenses' }

const ACTIONS: Record<NoticeAction['kind'], NoticeAction['action']> = { 'screen-permission': 'open-settings', about: 'licenses' }

/** Only the pairs above, whatever the page sends. */
export function parseNoticeAction(kind: unknown, action: unknown): NoticeAction | null {
  if (typeof kind !== 'string' || typeof action !== 'string' || !Object.hasOwn(ACTIONS, kind)) return null
  return ACTIONS[kind as NoticeAction['kind']] === action ? ({ kind, action } as NoticeAction) : null
}
