// Which rows a server's menu shows (rail right-click / long-press, and the server-name dropdown): the common
// things flat, the long tail of settings under "More settings", or everything flat when there are only a few.
import type { ServerSectionId } from '../settings/sections'

export type ServerMenuRow =
  | { kind: 'invite' }
  | { kind: 'channel' }
  /** "Server settings": the room, on its first section. */
  | { kind: 'settings'; section: ServerSectionId }
  | { kind: 'section'; section: ServerSectionId }
  | { kind: 'more' }

/** With this many sections or fewer, every one is listed flat (no "More settings"). */
export const FLAT_MAX = 4

/** Shown flat even when the rest go under "More settings". */
const COMMON: ServerSectionId[] = ['members', 'roles', 'reports']

/**
 * The admin rows of the menu, given the server sections you may open (in nav order). `more` holds what goes in
 * the "More settings" page; it's empty when everything is flat. No sections means no settings rows at all.
 */
export function serverMenuLayout(sections: ServerSectionId[], can: { invite: boolean; createChannel: boolean }): { rows: ServerMenuRow[]; more: ServerSectionId[] } {
  const rows: ServerMenuRow[] = []
  if (can.invite) rows.push({ kind: 'invite' })
  if (can.createChannel) rows.push({ kind: 'channel' })
  if (sections.length === 0) return { rows, more: [] }
  rows.push({ kind: 'settings', section: sections[0] })
  const rest: ServerSectionId[] = sections.filter((id) => id !== 'overview')
  if (sections.length <= FLAT_MAX) {
    rows.push(...rest.map((section) => ({ kind: 'section' as const, section })))
    return { rows, more: [] }
  }
  const flat = COMMON.filter((id) => rest.includes(id))
  let more = rest.filter((id) => !flat.includes(id))
  // A submenu of one is just a detour.
  if (more.length === 1) {
    flat.push(more[0])
    more = []
  }
  rows.push(...flat.map((section) => ({ kind: 'section' as const, section })))
  if (more.length > 0) rows.push({ kind: 'more' })
  return { rows, more }
}
