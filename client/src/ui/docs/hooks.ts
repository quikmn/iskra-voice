// Hooks shared by the docs views.
import { roleRank, type Channel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { canSendIn, has } from '../../state/permissions'
import { useRoleLookup, useServerRoles } from '../../state/roles'
import { useEmojiLookup } from '../expressions/useEmojiLookup'
import type { DocContext } from './docMarkdown'

/** What a member may do in a docs channel (mirrors the server's checks). */
export interface DocsAbilities {
  edit: boolean
  /** Delete anyone's page (trusted+ writers, message managers). Writers can always delete their own. */
  moderate: boolean
  /** Choose the "Start here" page. */
  home: boolean
}

export function useDocsAbilities(server: ServerState, channel: Channel): DocsAbilities {
  const roles = useServerRoles(server.key)
  const me = server.me
  const edit = canSendIn(me, channel, roles)
  return {
    edit,
    moderate: edit && !!me && (roleRank(me.role) >= roleRank('trusted') || has(me, roles, 'manageMessages')),
    home: has(me, roles, 'manageChannels'),
  }
}

export function useDocContext(server: ServerState): DocContext {
  const emoji = useEmojiLookup(server.key)
  const roleOf = useRoleLookup(server.key, server.me)
  return { nameOf: (k) => server.members[k]?.name ?? null, me: server.me?.accountKey, emoji, roleOf, serverKey: server.key, serverUrl: server.url }
}
