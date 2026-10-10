import { useState } from 'react'
import { activeServerState, useApp } from '../state/store'
import { ChannelSidebar } from './ChannelSidebar'
import { ChatView } from './ChatView'
import { JoinDialog } from './dialogs/JoinDialog'
import { MemberList } from './MemberList'
import { ServerRail } from './ServerRail'
import { useVoice } from '../state/voice'
import { VoiceStage } from './VoiceStage'
import { Menu } from './icons'

export type Panel = 'none' | 'nav' | 'members'

/** The main three-column layout. On phones the side columns become drawers. */
export function Shell() {
  const server = useApp(activeServerState)
  const [panel, setPanel] = useState<Panel>('none')
  const [joining, setJoining] = useState(false)
  const stage = useVoice((s) => s.stageOpen && s.session?.serverKey === server?.key)

  return (
    <div className={`shell panel-${panel}`}>
      <div className="nav-column">
        <ServerRail onJoin={() => setJoining(true)} onNavigate={() => setPanel('none')} />
        {server && <ChannelSidebar server={server} onNavigate={() => setPanel('none')} />}
      </div>

      <main className="main-column">
        {server && stage ? (
          <VoiceStage server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
        ) : server ? (
          <ChatView server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
        ) : (
          <EmptyState onJoin={() => setJoining(true)} onMenu={() => setPanel('nav')} />
        )}
      </main>

      {server && (
        <aside className="members-column">
          <MemberList server={server} />
        </aside>
      )}

      {panel !== 'none' && <div className="scrim" onClick={() => setPanel('none')} />}
      {joining && <JoinDialog onClose={() => setJoining(false)} />}
    </div>
  )
}

function EmptyState({ onJoin, onMenu }: { onJoin: () => void; onMenu: () => void }) {
  return (
    <div className="empty-state">
      <button className="icon-button mobile-only menu-button" onClick={onMenu} aria-label="Open menu">
        <Menu />
      </button>
      <h1>No servers yet</h1>
      <p>Ask a friend for an invite link, or start your own server and open the link it prints.</p>
      <button className="button primary" onClick={onJoin}>
        I have an invite link
      </button>
      <pre className="code-hint">iskra-server my-world</pre>
    </div>
  )
}
