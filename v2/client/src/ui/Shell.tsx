import { useState } from 'react'
import { activeServerState, useApp } from '../state/store'
import { ChannelSidebar } from './ChannelSidebar'
import { ChatView } from './ChatView'
import { JoinDialog } from './dialogs/JoinDialog'
import { CreateServerDialog } from './dialogs/CreateServerDialog'
import { desktop } from '../platform/desktop'
import { MemberList } from './MemberList'
import { ServerRail } from './ServerRail'
import { useVoice } from '../state/voice'
import { VoiceStage } from './VoiceStage'
import { HomeMain, HomeSidebar } from './Home'
import { RecoveryNudge } from './dialogs/RecoveryKey'
import { Menu } from './icons'

export type Panel = 'none' | 'nav' | 'members'

/** The main three-column layout. On phones the side columns become drawers. */
export function Shell() {
  const server = useApp(activeServerState)
  const [panel, setPanel] = useState<Panel>('none')
  const [joining, setJoining] = useState(false)
  const [creating, setCreating] = useState(false)
  const stage = useVoice((s) => s.stageOpen && s.session?.serverKey === server?.key)
  const hasServers = useApp((s) => s.order.length > 0)

  return (
    <div className={`shell panel-${panel} ${server ? '' : 'no-members'}`}>
      <div className="nav-column">
        <ServerRail onJoin={() => setJoining(true)} onNavigate={() => setPanel('none')} />
        {server ? <ChannelSidebar server={server} onNavigate={() => setPanel('none')} /> : <HomeSidebar onNavigate={() => setPanel('none')} />}
      </div>

      <main className="main-column">
        <RecoveryNudge />
        {server && stage ? (
          <VoiceStage server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
        ) : server ? (
          <ChatView server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
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

      {panel !== 'none' && <div className="scrim" onClick={() => setPanel('none')} />}
      {joining && <JoinDialog onClose={() => setJoining(false)} onCreate={desktop ? () => { setJoining(false); setCreating(true) } : undefined} />}
      {creating && <CreateServerDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

function EmptyState({ onJoin, onCreate, onMenu }: { onJoin: () => void; onCreate: () => void; onMenu: () => void }) {
  return (
    <div className="empty-state">
      <button className="icon-button mobile-only menu-button" onClick={onMenu} aria-label="Open menu">
        <Menu />
      </button>
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
          <p>Ask a friend for an invite link, or start your own server and open the link it prints.</p>
          <button className="button primary" onClick={onJoin}>
            I have an invite link
          </button>
          <pre className="code-hint">iskra-server my-world</pre>
        </>
      )}
    </div>
  )
}
