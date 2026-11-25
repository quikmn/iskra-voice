// "Hide buttons I don't use" (My settings → Appearance): optional buttons in the composer, the channel and DM headers
// and the voice bar that a person took off the screen. Kept on this device, like the theme (a phone and a desktop
// have different room). A hidden button's feature stays reachable from a menu; nothing is turned off.
import { create } from 'zustand'

/** Every button that can be hidden, in the order the settings list them. Each has another way in (see `where`). */
export const HIDEABLE_BUTTONS = ['gif', 'emoji', 'voiceMessage', 'threads', 'pins', 'search', 'calls', 'soundboard'] as const
export type HideableButton = (typeof HIDEABLE_BUTTONS)[number]

/** Where each button is: the settings group it is listed under. */
export const BUTTON_PLACE: Record<HideableButton, 'composer' | 'header' | 'voice'> = {
  gif: 'composer', emoji: 'composer', voiceMessage: 'composer',
  threads: 'header', pins: 'header', search: 'header', calls: 'header',
  soundboard: 'voice',
}

const STORAGE_KEY = 'iskra.buttons'

/** Reads a stored list; anything that isn't a known button is dropped. */
export function parseHiddenButtons(raw: unknown): HideableButton[] {
  if (!Array.isArray(raw)) return []
  return HIDEABLE_BUTTONS.filter((id) => raw.includes(id))
}

/** The list with one button hidden or shown again, in the fixed order. */
export function withButtonHidden(hidden: HideableButton[], id: HideableButton, hide: boolean): HideableButton[] {
  return HIDEABLE_BUTTONS.filter((b) => (b === id ? hide : hidden.includes(b)))
}

function load(): HideableButton[] {
  try {
    return parseHiddenButtons(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'))
  } catch {
    return []
  }
}

export const useHiddenButtons = create<{ hidden: HideableButton[] }>(() => ({ hidden: load() }))

/** Whether the person hid this button. */
export const useButtonHidden = (id: HideableButton): boolean => useHiddenButtons((s) => s.hidden.includes(id))

export function setButtonHidden(id: HideableButton, hide: boolean): void {
  const hidden = withButtonHidden(useHiddenButtons.getState().hidden, id, hide)
  useHiddenButtons.setState({ hidden })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hidden))
  } catch {
    /* private mode */
  }
}

export function showAllButtons(): void {
  useHiddenButtons.setState({ hidden: [] })
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* private mode */
  }
}
