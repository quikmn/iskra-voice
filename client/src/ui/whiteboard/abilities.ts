// What a member may do on a whiteboard, and which calls show their board (shared by the views).
import { create } from 'zustand'
import { roleRank, type Channel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { canSendIn, has } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import { useEncryptedWriteBlock } from '../e2ee/E2ee'

/** Which calls show their board (per channel, on this device). */
export const useBoardShown = create<Record<string, boolean>>(() => ({}))

/** What a member may do on a board (mirrors the server's checks). */
export function useBoardAbilities(server: ServerState, channel: Channel, openedBy?: string | null) {
  const roles = useServerRoles(server.key)
  const me = server.me
  const blocked = useEncryptedWriteBlock(server, channel.id)
  const canDraw = canSendIn(me, channel, roles) && !blocked
  const moderator = canDraw && !!me && (roleRank(me.role) >= roleRank('trusted') || has(me, roles, 'manageMessages'))
  return { canDraw, canClear: moderator || (canDraw && channel.kind === 'voice' && !!openedBy && openedBy === me?.accountKey), blocked }
}

