import { useState } from 'react'
import { roleRank } from '../core/protocol'
import { activeChannelId, selectChannel, useApp, type ServerState } from '../state/store'
import { joinVoice, setStageOpen, useVoice } from '../state/voice'
import { Avatar } from './bits'
import { openProfileCard } from '../state/profile'
import { VoiceBar } from './VoiceBar'
import { CreateChannelDialog } from './dialogs/CreateChannelDialog'
import { InviteDialog } from './dialogs/InviteDialog'
import { SettingsDialog } from './dialogs/SettingsDialog'
import { Hash, HeadphonesOff, Lock, MicOff, Plus, Settings, UserPlus, Volume } from './icons'

export function ChannelSidebar({ server, onNavigate }: { server: ServerState; onNavigate: () => void }) {
  const activeId = useApp(activeChannelId)
  const [dialog, setDialog] = useState<'invite' | 'channel' | 'settings' | null>(null)
  const isAdmin = server.me ? roleRank(server.me.role) >= roleRank('admin') : false
  const canInvite = server.me ? roleRank(server.me.role) >= roleRank('member') : false
  const textChannels = server.channels.filter((c) => c.kind === 'text')
  const voiceChannels = server.channels.filter((c) => c.kind === 'voice')
  const voiceSession = useVoice((s) => s.session)
  const speaking = useVoice((s) => s.speaking)

  return (
    <div className="channel-sidebar">
      <header className="sidebar-header">
        <h2 title={server.name}>{server.name}</h2>
        <ConnectionPill server={server} />
      </header>

      <div className="channel-list">
        {canInvite && (
          <button className="invite-button" onClick={() => setDialog('invite')}>
            <UserPlus size={16} /> Invite friends
          </button>
        )}
        <div className="channel-group">
          <span>Text channels</span>
          {isAdmin && (
            <button className="icon-button small" onClick={() => setDialog('channel')} aria-label="Create channel" title="Create channel">
              <Plus size={14} />
            </button>
          )}
        </div>
        {textChannels.map((channel) => {
          const unread = server.unread[channel.id] ?? 0
          const pings = server.mentions[channel.id] ?? 0
          return (
            <button
              key={channel.id}
              className={`channel ${channel.id === activeId ? 'active' : ''} ${unread ? 'unread' : ''}`}
              onClick={() => {
                selectChannel(server.key, channel.id)
                setStageOpen(false)
                onNavigate()
              }}
            >
              <span className="hash"><Hash size={16} /></span>
              <span className="channel-name">{channel.name}</span>
              {channel.readRole !== 'member' && channel.readRole !== 'guest' && <span className="lock" title={`${channel.readRole}+ only`}><Lock size={12} /></span>}
              {pings > 0 && channel.id !== activeId && <span className="badge" title="Mentions">{pings}</span>}
            </button>
          )
        })}
        {(voiceChannels.length > 0 || isAdmin) && (
          <div className="channel-group">
            <span>Voice channels</span>
            {isAdmin && (
              <button className="icon-button small" onClick={() => setDialog('channel')} aria-label="Create voice channel" title="Create channel">
                <Plus size={14} />
              </button>
            )}
          </div>
        )}
        {voiceChannels.map((channel) => {
          const participants = server.voice[channel.id] ?? []
          const here = voiceSession?.serverKey === server.key && voiceSession.channelId === channel.id
          return (
            <div key={channel.id} className="voice-channel">
              <button
                className={`channel ${here ? 'active' : ''}`}
                disabled={!server.voiceAvailable}
                title={server.voiceAvailable ? `Join ${channel.name}` : 'Voice is unavailable on this server'}
                onClick={() => {
                  void joinVoice(server.key, channel.id)
                  onNavigate()
                }}
              >
                <span className="hash"><Volume size={16} /></span>
                <span className="channel-name">{channel.name}</span>
                {here && voiceSession.state !== 'connected' && <span className="pill">…</span>}
              </button>
              {participants.length > 0 && (
                <ul className="voice-participants">
                  {participants.map((p) => {
                    const member = server.members[p.accountKey]
                    return (
                      <li key={p.accountKey} className={here && speaking[p.accountKey] ? 'speaking' : ''}>
                        <button className="participant" onClick={(e) => openProfileCard(server.key, p.accountKey, e.currentTarget)}>
                          <Avatar name={member?.name ?? '?'} accountKey={p.accountKey} size={22} />
                          <span className="member-name">{member?.name ?? 'Someone'}</span>
                        </button>
                        {p.deafened ? <span className="voice-flag" title="Deafened"><HeadphonesOff size={14} /></span> : p.muted ? <span className="voice-flag" title="Muted"><MicOff size={14} /></span> : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      <VoiceBar />
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
        <Settings />
      </button>
    </div>
  )
}
