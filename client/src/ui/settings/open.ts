// Which settings view is open: My settings, or one server's settings room (pinned to that server's key, never
// following the active server). Rendered once by the Shell (SettingsLayer).
import { create } from 'zustand'
import type { MySectionId, ServerSectionId } from './sections'

export type SettingsView =
  | { kind: 'mine'; section?: MySectionId }
  | { kind: 'server'; serverKey: string; section?: ServerSectionId }

export const useSettingsView = create<{ view: SettingsView | null; opened: number }>(() => ({ view: null, opened: 0 }))

/** `opened` changes on every open, so opening the same view again lands on the asked-for section. */
const show = (view: SettingsView) => useSettingsView.setState((s) => ({ view, opened: s.opened + 1 }))

export const openMySettings = (section?: MySectionId) => show({ kind: 'mine', section })
export const openServerSettings = (serverKey: string, section?: ServerSectionId) => show({ kind: 'server', serverKey, section })
export const closeSettings = () => useSettingsView.setState({ view: null })
