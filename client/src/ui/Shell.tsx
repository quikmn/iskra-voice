import { useState } from 'react'
import { activeServerState, useApp } from '../state/store'
import { ChannelSidebar } from './ChannelSidebar'
import { ChatArea } from './chat/ChatArea'
import { JoinDialog } from './dialogs/JoinDialog'
import { CreateServerDialog } from './dialogs/CreateServerDialog'
import { StartServerDialog } from './dialogs/StartServerDialog'
import { desktop } from '../platform/desktop'
import { MemberList } from './MemberList'
import { ServerRail } from './ServerRail'
import { useVoice } from '../state/voice'
import { VoiceStage } from './VoiceStage'
import { StageView } from './stage/StageView'
import { HomeMain, HomeSidebar } from './Home'
import { RecoveryNudge } from './dialogs/RecoveryKey'
import { Menu } from './icons'
import { IncomingCall } from './calls/Calls'
import { IncomingGroupCall } from './groups/GroupCall'
import { SoundToasts } from './expressions/Soundboard'
import { ProfileLayer } from './profile/ProfileLayer'
import { QuickSwitcher } from './QuickSwitcher'
import { useEscapeLayer } from './layers'
import { EventsLayer } from './events/EventsLayer'

export type Panel = 'none' | 'nav' | 'members'

/** The main three-column layout. On phones the side columns become drawers. */
export function Shell() {
  const server = useApp(activeServerState)
  const [panel, setPanel] = useState<Panel>('none')
  const [joining, setJoining] = useState(false)
  const [creating, setCreating] = useState(false)
  const stage = useVoice((s) => s.stageOpen && s.session?.serverKey === server?.key && !s.session?.call && !s.session?.group)
  const stageChannel = useVoice((s) => s.session?.channelId)
  const isStageChannel = !!server?.channels.some((c) => c.id === stageChannel && c.kind === 'stage')
  const hasServers = useApp((s) => s.order.length > 0)
  // Escape closes an open drawer (phones and narrow windows).
  useEscapeLayer(() => setPanel('none'), panel !== 'none')

  return (
    <div className={`shell panel-${panel} ${server ? '' : 'no-members'}`}>
      <div className="nav-column">
        <ServerRail onJoin={() => setJoining(true)} onNavigate={() => setPanel('none')} />
        {server ? <ChannelSidebar server={server} onNavigate={() => setPanel('none')} /> : <HomeSidebar onNavigate={() => setPanel('none')} />}
      </div>

      <main className="main-column">
        <RecoveryNudge />
        {server && stage ? (
          isStageChannel
            ? <StageView server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
            : <VoiceStage server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
        ) : server ? (
          <ChatArea server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
        ) : hasServers ? (
          <HomeMain onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
        ) : (
          <EmptyState onJoin={() => setJoining(true)} onCreate={() => setCreating(true)} onMenu={() => setPanel('nav')} />
        )}
      </main>

      {server && (
        <aside className="members-column">
          <MemberList server={server} />
        </aside>
      )}

      <SoundToasts />
      {panel !== 'none' && <div className="scrim" onClick={() => setPanel('none')} />}
      <IncomingCall />
      <IncomingGroupCall />
      <ProfileLayer />
      <QuickSwitcher />
      <EventsLayer />
      {joining && <JoinDialog onClose={() => setJoining(false)} onCreate={() => { setJoining(false); setCreating(true) }} />}
      {creating && (desktop ? <CreateServerDialog onClose={() => setCreating(false)} /> : <StartServerDialog onClose={() => setCreating(false)} />)}
    </div>
  )
}

function EmptyState({ onJoin, onCreate, onMenu }: { onJoin: () => void; onCreate: () => void; onMenu: () => void }) {
  return (
    <div className="empty-state">
      <button className="icon-button mobile-only menu-button" onClick={onMenu} aria-label="Open menu">
        <Menu />
      </button>
      <span className="empty-icon" aria-hidden>
        <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="currentColor" /></svg>
      </span>
      <h1>No servers yet</h1>
      {desktop ? (
        <>
          <p>Start your own server on this computer, or join a friend's with an invite link.</p>
          <div className="copy-row">
            <button className="button primary" onClick={onCreate}>Create a server</button>
            <button className="button" onClick={onJoin}>I have an invite link</button>
          </div>
        </>
      ) : (
        <>
          <p>Join a friend's server with their invite link, or start your own in a couple of minutes.</p>
          <div className="copy-row">
            <button className="button primary" onClick={onJoin}>I have an invite link</button>
            <button className="button" onClick={onCreate}>Start your own server</button>
          </div>
        </>
      )}
    </div>
  )
}
