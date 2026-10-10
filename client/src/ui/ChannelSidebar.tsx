import { useState } from 'react'
import { roleRank } from '../core/protocol'
import { useApp, type ServerState } from '../state/store'
import { useThreads } from '../state/threads'
import { VoiceBar } from './VoiceBar'
import { MeStatusButton } from './presence/Presence'
import { ChannelList } from './organize/ChannelList'
import { CreateChannelDialog } from './dialogs/CreateChannelDialog'
import { InviteDialog } from './dialogs/InviteDialog'
import { SettingsDialog } from './settings/SettingsDialog'
import { ChevronDown, Settings, UserPlus } from './icons'
import type { SectionId } from './settings/sections'
import { EventsButton } from './events/EventsLayer'

export function ChannelSidebar({ server, onNavigate }: { server: ServerState; onNavigate: () => void }) {
  const [dialog, setDialog] = useState<'invite' | 'channel' | 'settings' | null>(null)
  const [section, setSection] = useState<SectionId | undefined>(undefined)
  const openSettings = (at?: SectionId) => {
    setSection(at)
    setDialog('settings')
  }
  const isAdmin = server.me ? roleRank(server.me.role) >= roleRank('admin') : false
  const canInvite = server.me ? roleRank(server.me.role) >= roleRank('member') : false
  const [createIn, setCreateIn] = useState<number | null>(null)
  useThreads((s) => s.threads[server.key]) // thread mentions count on their channel

  return (
    <div className="channel-sidebar">
      <header className="sidebar-header">
        <button className="server-header-button" onClick={() => openSettings('overview')} aria-label={`${server.name}: server options`} title="Server options">
          <span className="server-name">{server.name}</span>
          <ConnectionPill server={server} />
          <ChevronDown size={16} />
        </button>
      </header>

      <div className="channel-list">
        <EventsButton server={server} onNavigate={onNavigate} />
        {canInvite && (
          <button className="invite-button" onClick={() => setDialog('invite')}>
            <UserPlus size={16} /> Invite friends
          </button>
        )}
        <ChannelList server={server} isAdmin={isAdmin} onNavigate={onNavigate} onCreateChannel={(categoryId) => {
          setCreateIn(categoryId)
          setDialog('channel')
        }} />
      </div>

      <VoiceBar />
      <MeBar server={server} onSettings={() => openSettings()} />

      {dialog === 'invite' && <InviteDialog server={server} onClose={() => setDialog(null)} />}
      {dialog === 'channel' && <CreateChannelDialog server={server} categoryId={createIn} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog server={server} section={section} onClose={() => setDialog(null)} />}
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
      {me ? (
        <MeStatusButton name={name} accountKey={me.accountKey} sub={me.role} />
      ) : (
        <div className="me-text">
          <strong>{name}</strong>
          <span>not joined</span>
        </div>
      )}
      <button className="icon-button" onClick={onSettings} aria-label="Settings" title="Settings">
        <Settings />
      </button>
    </div>
  )
}
