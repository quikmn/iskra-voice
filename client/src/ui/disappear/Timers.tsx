// The disappearing-messages button for each kind of conversation, wired to its state.
import type { Channel } from '../../core/protocol'
import { has } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import type { ServerState } from '../../state/store'
import { setChannelTimer, setDmTimer, setGroupTimer, useChannelTimer, useDmTimer, useGroupTimer } from '../../state/disappearing'
import { DisappearButton } from './Disappear'

export function DmTimerButton({ peer, canChange }: { peer: string; canChange: boolean }) {
  const seconds = useDmTimer(peer)
  return <DisappearButton kind="dm" seconds={seconds} canChange={canChange} onSet={(s) => setDmTimer(peer, s)} />
}

export function GroupTimerButton({ groupKey, canChange }: { groupKey: string; canChange: boolean }) {
  const seconds = useGroupTimer(groupKey)
  return <DisappearButton kind="group" seconds={seconds} canChange={canChange} onSet={(s) => setGroupTimer(groupKey, s)} />
}

/** Channels: people who manage channels change it; everyone sees it while it's on. Threads follow their channel. */
export function ChannelTimerButton({ server, channel }: { server: ServerState; channel: Channel }) {
  const roles = useServerRoles(server.key)
  const seconds = useChannelTimer(server.key, channel.id)
  const canChange = has(server.me, roles, 'manageChannels')
  return <DisappearButton kind="channel" seconds={seconds} canChange={canChange} onSet={(s) => setChannelTimer(server.key, channel.id, s)} />
}
