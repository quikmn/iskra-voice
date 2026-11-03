// Which settings rows a server's menu shows (rail right-click / long-press, and the server-name dropdown): "Server
// settings" and everything else under "More settings" (grouped like the room's nav), or every section flat when there
// are only a few (a moderator with Members and Reports sees just those).
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
  // A few sections are quicker flat than behind a submenu (and past FLAT_MAX the submenu is never a detour of one).
  if (sections.length <= FLAT_MAX) {
    rows.push(...rest.map((section) => ({ kind: 'section' as const, section })))
    return { rows, more: [] }
  }
  rows.push({ kind: 'more' })
  return { rows, more: rest }
}
