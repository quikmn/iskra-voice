import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { roleRank } from '../core/protocol'
import { has } from '../state/permissions'
import { useServerRoles } from '../state/roles'
import { useApp, type ServerState } from '../state/store'
import { useThreads } from '../state/threads'
import { VoiceBar } from './VoiceBar'
import { MeStatusButton } from './presence/Presence'
import { ChannelList } from './organize/ChannelList'
import { CreateChannelDialog } from './dialogs/CreateChannelDialog'
import { InviteDialog } from './dialogs/InviteDialog'
import { openMySettings, openServerSettings } from './settings/open'
import { ChevronDown, HeadphonesOff, MicOff, Settings, UserPlus } from './icons'
import { useVoice } from '../state/voice'
import { EventsButton } from './events/EventsLayer'
import { RulesButton } from './rules/Rules'
import { ReportsButton } from './safety/ReportsSection'
import { errorMessage } from '../i18n/errors'
import type { MenuAnchor } from './organize/OrgMenu'
import { ServerMenu } from './organize/ServerMenu'
import './audio.css'

export function ChannelSidebar({ server, onNavigate }: { server: ServerState; onNavigate: () => void }) {
  const { t } = useTranslation()
  const [dialog, setDialog] = useState<'invite' | 'channel' | null>(null)
  const isAdmin = has(server.me, useServerRoles(server.key), 'manageChannels') // may create channels
  const canInvite = server.me ? roleRank(server.me.role) >= roleRank('member') : false
  const [createIn, setCreateIn] = useState<number | null>(null)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  useThreads((s) => s.threads[server.key]) // thread mentions count on their channel

  return (
    <div className="channel-sidebar">
      <header className="sidebar-header">
        <button
          className="server-header-button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left + 8, y: r.bottom + 4 })
          }}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          aria-label={t('app.sidebar.serverOptionsLabel', { name: server.name })}
          title={t('app.sidebar.serverOptions')}
        >
          <span className="server-name">{server.name}</span>
          <ConnectionPill server={server} />
          <ChevronDown size={16} />
        </button>
      </header>
      {menu && <ServerMenu server={server} anchor={menu} onClose={() => setMenu(null)} />}

      <div className="channel-list">
        <ReportsButton server={server} onOpen={() => openServerSettings(server.key, 'reports')} />
        <RulesButton server={server} onNavigate={onNavigate} />
        <EventsButton server={server} onNavigate={onNavigate} />
        {canInvite && (
          <button className="invite-button" onClick={() => setDialog('invite')}>
            <UserPlus size={16} /> {t('app.sidebar.inviteFriends')}
          </button>
        )}
        <ChannelList server={server} isAdmin={isAdmin} onNavigate={onNavigate} onCreateChannel={(categoryId) => {
          setCreateIn(categoryId)
          setDialog('channel')
        }} />
      </div>

      <VoiceBar />
      <MeBar server={server} onSettings={() => openMySettings()} />

      {dialog === 'invite' && <InviteDialog server={server} onClose={() => setDialog(null)} />}
      {dialog === 'channel' && <CreateChannelDialog server={server} categoryId={createIn} onClose={() => setDialog(null)} />}
    </div>
  )
}

function ConnectionPill({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const { status } = server
  if (status.state === 'online') return null
  const label =
    status.state === 'connecting' ? t('app.sidebar.connecting')
      : status.state === 'offline' ? t('app.sidebar.reconnectingIn', { seconds: Math.ceil(status.retryInMs / 1000) })
        : status.state === 'restarting' ? t('app.sidebar.restarting')
        : t('app.sidebar.noAccess')
  return <span className={`pill ${status.state}`} title={status.state === 'rejected' ? errorMessage(status) : undefined}>{label}</span>
}

function MeBar({ server, onSettings }: { server: ServerState; onSettings: () => void }) {
  const { t } = useTranslation()
  const profile = useApp((s) => s.profile)
  const me = server.me
  const name = me?.name ?? profile?.name ?? ''
  const inVoice = useVoice((s) => !!s.session && s.session.state === 'connected')
  const speaking = useVoice((s) => s.localSpeaking)
  const muted = useVoice((s) => s.muted)
  const deafened = useVoice((s) => s.deafened)
  const flag = inVoice && (deafened ? t('voice.deafened') : muted ? t('voice.muted') : null)
  return (
    <div className="me-bar">
      {me ? (
        <MeStatusButton name={name} accountKey={me.accountKey} sub={t(`common.roles.${me.role}`)} speaking={inVoice && speaking}
          title={inVoice ? (flag || (speaking ? t('voice.speaking') : t('voice.inVoice'))) : undefined}
          flag={flag ? <span className="me-avatar-flag" aria-label={flag}>{deafened ? <HeadphonesOff size={11} /> : <MicOff size={11} />}</span> : null} />
      ) : (
        <div className="me-text">
          <strong>{name}</strong>
          <span>{t('app.sidebar.notJoined')}</span>
        </div>
      )}
      <button className="icon-button" onClick={onSettings} aria-label={t('common.settings')} title={t('settings.room.mine')}>
        <Settings />
      </button>
    </div>
  )
}
