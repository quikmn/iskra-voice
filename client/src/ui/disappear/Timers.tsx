// The disappearing-messages tool for each kind of conversation's header, wired to its state.
import type { Channel } from '../../core/protocol'
import { has } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import type { ServerState } from '../../state/store'
import { setChannelTimer, setDmTimer, setGroupTimer, useChannelTimer, useDmTimer, useGroupTimer } from '../../state/disappearing'
import { useDisappearTool } from './Disappear'

export function useDmTimerTool(peer: string, canChange: boolean) {
  const seconds = useDmTimer(peer)
  return useDisappearTool({ kind: 'dm', seconds, canChange, onSet: (s) => setDmTimer(peer, s) })
}

export function useGroupTimerTool(groupKey: string, canChange: boolean) {
  const seconds = useGroupTimer(groupKey)
  return useDisappearTool({ kind: 'group', seconds, canChange, onSet: (s) => setGroupTimer(groupKey, s) })
}

/** Channels: people who manage channels change it; everyone sees it while it's on. Threads follow their channel. */
export function useChannelTimerTool(server: ServerState, channel: Channel) {
  const roles = useServerRoles(server.key)
  const seconds = useChannelTimer(server.key, channel.id)
  const canChange = has(server.me, roles, 'manageChannels')
  return useDisappearTool({ kind: 'channel', seconds, canChange, onSet: (s) => setChannelTimer(server.key, channel.id, s) })
}
