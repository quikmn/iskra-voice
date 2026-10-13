import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activeServerState, useApp } from '../state/store'
import { ChannelSidebar } from './ChannelSidebar'
import { ChatArea } from './chat/ChatArea'
import { JoinDialog, useOpenJoinRequests } from './dialogs/JoinDialog'
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
import { IncomingCall } from './calls/Calls'
import { IncomingGroupCall } from './groups/GroupCall'
import { SoundToasts } from './expressions/Soundboard'
import { ProfileLayer } from './profile/ProfileLayer'
import { UserMenuLayer } from './people/UserMenu'
import { ServerActionLayer } from './organize/ServerMenu'
import { SettingsLayer } from './settings/LazySettings'
import { QuickSwitcher } from './QuickSwitcher'
import { useEscapeLayer } from './layers'
import { EventsLayer } from './events/EventsLayer'
import { DisputeNotices } from './keys/KeyScreens'
import { KtNotices } from './keys/KeyTransparency'
import { Shortcuts } from './organize/Shortcuts'
import { RulesLayer } from './rules/Rules'
import { ServerUpdateNotice } from './ServerUpdateNotice'
import { RestartBanner } from './RestartBanner'
import { ProductivityLayer } from './productivity/InboxButton'
import { VoiceRoom } from './clips/VoiceRoom'
import { ClipLayer } from './clips/ClipControls'

export type Panel = 'none' | 'nav' | 'members'

/** The main three-column layout. On phones the side columns become drawers. */
export function Shell() {
  const { t } = useTranslation()
  const server = useApp(activeServerState)
  const [panel, setPanel] = useState<Panel>('none')
  const [joining, setJoining] = useState(false)
  useOpenJoinRequests(useCallback(() => setJoining(true), []))
  const [creating, setCreating] = useState(false)
  const stage = useVoice((s) => s.stageOpen && s.session?.serverKey === server?.key && !s.session?.call && !s.session?.group)
  const stageChannel = useVoice((s) => s.session?.channelId)
  const isStageChannel = !!server?.channels.some((c) => c.id === stageChannel && c.kind === 'stage')
  const hasServers = useApp((s) => s.order.length > 0)
  // Escape closes an open drawer (phones and narrow windows).
  useEscapeLayer(() => setPanel('none'), panel !== 'none')

  return (
    <div className={`shell panel-${panel} ${server ? '' : 'no-members'}`}>
      <button className="skip-link" onClick={() => document.getElementById('main-content')?.focus()}>{t('app.skipToContent')}</button>
      <div className="nav-column">
        <ServerRail onJoin={() => setJoining(true)} onNavigate={() => setPanel('none')} />
        {server ? <ChannelSidebar server={server} onNavigate={() => setPanel('none')} /> : <HomeSidebar onNavigate={() => setPanel('none')} />}
      </div>

      <main className="main-column" id="main-content" tabIndex={-1}>
        <RecoveryNudge />
        <DisputeNotices />
        {server && <ServerUpdateNotice server={server} />}
        {server && <RestartBanner server={server} />}
        <KtNotices />
        {server && stage ? (
          <VoiceRoom server={server}>
            {isStageChannel
              ? <StageView server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
              : <VoiceStage server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />}
          </VoiceRoom>
        ) : server ? (
          <ChatArea server={server} onToggle={(p) => setPanel(panel === p ? 'none' : p)} />
        ) : (
          // With no servers yet, the Friends page leads with how to join or start one.
          <HomeMain
            onToggle={(p) => setPanel(panel === p ? 'none' : p)}
            start={hasServers ? undefined : <StartCard onJoin={() => setJoining(true)} onCreate={() => setCreating(true)} />}
          />
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
      <UserMenuLayer />
      <ServerActionLayer />
      <SettingsLayer />
      <QuickSwitcher />
      <EventsLayer />
      <Shortcuts />
      <RulesLayer />
      <ProductivityLayer />
      <ClipLayer />
      {joining && <JoinDialog onClose={() => setJoining(false)} onCreate={() => { setJoining(false); setCreating(true) }} />}
      {creating && (desktop ? <CreateServerDialog onClose={() => setCreating(false)} /> : <StartServerDialog onClose={() => setCreating(false)} />)}
    </div>
  )
}

function StartCard({ onJoin, onCreate }: { onJoin: () => void; onCreate: () => void }) {
  const { t } = useTranslation()
  return (
    <section className="empty-state start-card" aria-labelledby="start-card-title">
      <span className="empty-icon" aria-hidden>
        <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="currentColor" /></svg>
      </span>
      <h2 id="start-card-title">{t('app.empty.title')}</h2>
      {desktop ? (
        <>
          <p>{t('app.empty.desktop')}</p>
          <div className="copy-row">
            <button className="button primary" onClick={onCreate}>{t('app.empty.create')}</button>
            <button className="button" onClick={onJoin}>{t('app.empty.haveInvite')}</button>
          </div>
        </>
      ) : (
        <>
          <p>{t('app.empty.web')}</p>
          <div className="copy-row">
            <button className="button primary" onClick={onJoin}>{t('app.empty.haveInvite')}</button>
            <button className="button" onClick={onCreate}>{t('app.empty.start')}</button>
          </div>
        </>
      )}
    </section>
  )
}
