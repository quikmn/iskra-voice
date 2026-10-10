import { useState } from 'react'
import { roleRank } from '../core/protocol'
import { activeChannelId, selectChannel, useApp, type ServerState } from '../state/store'
import { Avatar } from './bits'
import { CreateChannelDialog } from './dialogs/CreateChannelDialog'
import { InviteDialog } from './dialogs/InviteDialog'
import { SettingsDialog } from './dialogs/SettingsDialog'

export function ChannelSidebar({ server, onNavigate }: { server: ServerState; onNavigate: () => void }) {
  const activeId = useApp(activeChannelId)
  const [dialog, setDialog] = useState<'invite' | 'channel' | 'settings' | null>(null)
  const isAdmin = server.me ? roleRank(server.me.role) >= roleRank('admin') : false
  const canInvite = server.me ? roleRank(server.me.role) >= roleRank('member') : false
  const textChannels = server.channels.filter((c) => c.kind === 'text')

  return (
    <div className="channel-sidebar">
      <header className="sidebar-header">
        <h2 title={server.name}>{server.name}</h2>
        <ConnectionPill server={server} />
      </header>

      <div className="channel-list">
        {canInvite && (
          <button className="invite-button" onClick={() => setDialog('invite')}>
            + Invite friends
          </button>
        )}
        <div className="channel-group">
          <span>Text channels</span>
          {isAdmin && (
            <button className="icon-button small" onClick={() => setDialog('channel')} aria-label="Create channel" title="Create channel">
              +
            </button>
          )}
        </div>
        {textChannels.map((channel) => {
          const unread = server.unread[channel.id] ?? 0
          return (
            <button
              key={channel.id}
              className={`channel ${channel.id === activeId ? 'active' : ''} ${unread ? 'unread' : ''}`}
              onClick={() => {
                selectChannel(server.key, channel.id)
                onNavigate()
              }}
            >
              <span className="hash">#</span>
              <span className="channel-name">{channel.name}</span>
              {channel.readRole !== 'member' && channel.readRole !== 'guest' && <span className="lock" title={`${channel.readRole}+ only`}>🔒</span>}
              {unread > 0 && channel.id !== activeId && <span className="badge">{unread}</span>}
            </button>
          )
        })}
      </div>

      <MeBar server={server} onSettings={() => setDialog('settings')} />

      {dialog === 'invite' && <InviteDialog server={server} onClose={() => setDialog(null)} />}
      {dialog === 'channel' && <CreateChannelDialog server={server} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog server={server} onClose={() => setDialog(null)} />}
    </div>
  )
}

function ConnectionPill({ server }: { server: ServerState }) {
  const { status } = server
  if (status.state === 'online') return null
  const label =
    status.state === 'connecting' ? 'Connecting…'
      : status.state === 'offline' ? `Reconnecting in ${Math.ceil(status.retryInMs / 1000)}s`
        : 'No access'
  return <span className={`pill ${status.state}`} title={status.state === 'rejected' ? status.message : undefined}>{label}</span>
}

function MeBar({ server, onSettings }: { server: ServerState; onSettings: () => void }) {
  const profile = useApp((s) => s.profile)
  const me = server.me
  const name = me?.name ?? profile?.name ?? ''
  return (
    <div className="me-bar">
      {me && <Avatar name={name} accountKey={me.accountKey} size={32} online={server.status.state === 'online'} />}
      <div className="me-text">
        <strong>{name}</strong>
        <span>{me?.role ?? 'not joined'}</span>
      </div>
      <button className="icon-button" onClick={onSettings} aria-label="Settings" title="Settings">
        ⚙
      </button>
    </div>
  )
}
