// Small pieces for join-to-create rooms elsewhere in the app: the channel menu item and the voice bar button that open
// the host's room settings, and the lobby/lock marks in the channel list.
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import { has } from '../../state/permissions'
import { useServerRoles } from '../../state/roles'
import { openRoomSettings } from '../../state/rooms'
import { hostsRoom, isLobby } from '../../state/roomsLogic'
import { useApp, type ServerState } from '../../state/store'
import { useVoice } from '../../state/voice'
import { Lock, Sliders } from '../icons'
import { MenuItem } from '../organize/OrgMenu'
import './rooms.css'

/** Channel menu: "Room settings…" for the host of a room (and channel managers). */
export function RoomMenuItem({ server, channel, onClose }: { server: ServerState; channel: Channel; onClose: () => void }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  if (!hostsRoom(channel, server.me, has(server.me, roles, 'manageChannels'))) return null
  return <MenuItem onClick={() => { openRoomSettings(server.key, channel.id); onClose() }}>{t('rooms.settings.menu')}</MenuItem>
}

/** Voice bar: opens your room's settings while you host the room you're in. */
export function RoomButton() {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)
  const server = useApp((s) => (session ? s.servers[session.serverKey] : undefined))
  const roles = useServerRoles(server?.key)
  const channel = server?.channels.find((c) => c.id === session?.channelId)
  if (!server || !session || session.call || session.group || !hostsRoom(channel, server.me, has(server.me, roles, 'manageChannels'))) return null
  return (
    <button className="icon-button" onClick={() => openRoomSettings(server.key, channel!.id)} aria-label={t('rooms.settings.button')} title={t('rooms.settings.button')} data-testid="room-button">
      <Sliders />
    </button>
  )
}

/** Next to a voice channel's name: "Lobby", or a lock while a room is locked. */
export function RoomMarks({ channel }: { channel: Channel }) {
  const { t } = useTranslation()
  if (isLobby(channel)) return <span className="lobby-badge" title={t('rooms.lobby.badgeHint')}>{t('rooms.lobby.badge')}</span>
  if (channel.room?.locked) return <span className="room-lock" title={t('rooms.room.lockedHint', { name: channel.name })} aria-label={t('rooms.room.locked')}><Lock size={12} /></span>
  return null
}
