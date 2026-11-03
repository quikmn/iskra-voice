import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activeChannelId, activeServerState, failedJoin, useApp, type ServerState } from '../state/store'
import { ErrorBoundary } from './ErrorBoundary'
import { ChannelSidebar } from './ChannelSidebar'
import { ChatArea } from './chat/ChatArea'
import { JoinDialog, useOpenJoinRequests } from './dialogs/JoinDialog'
import { CreateServerDialog } from './dialogs/CreateServerDialog'
import { ClaimServerDialog } from './dialogs/ClaimServerDialog'
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
import { OuthookToast } from './OuthookToast'
import { AfkToast } from './afk/AfkToast'
import { WarnToast } from './moderation/ModPack'
import { LfgLayer, LfgToast } from './lfg/Lfg'
import { TeamsBar } from './teams/TeamsBits'
import { TeamsLayer } from './teams/TeamsDialog'
import { RoomLayer } from './rooms/RoomDialog'
import { StreamerPill } from './streamer/StreamerBits'
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
import { RolePickerLayer } from './roles/Onboarding'
import { ServerUpdateNotice } from './ServerUpdateNotice'
import { RestartBanner } from './RestartBanner'
import { ProductivityLayer } from './productivity/InboxButton'
import { VoiceRoom } from './clips/VoiceRoom'
import { ClipLayer } from './clips/ClipControls'
import { RecordingLayer } from './recording/Recording'
import { PopoutLayer } from './popout/PopoutLayer'
import { QuietDigestCard } from './quietDigest/QuietDigestCard'
import { usePhoneNav } from './nav/PhoneNav'
import { AssistantLayer } from './assistant/AssistantPanel'
import { Spark } from './icons'

export type Panel = 'none' | 'nav' | 'members'

/**
 * The members column only where there's a member list to show: not while a join waits for a moderator, couldn't reach
 * its server, or was turned away (the main pane then is a card with what to do, and nothing beside it).
 */
function hasMembers(server: ServerState): boolean {
  if (server.status.state === 'pending' || failedJoin(server)) return false
  return !(server.status.state === 'rejected' && !server.me)
}

/** The main three-column layout. On phones the side columns become drawers. */
export function Shell() {
  const { t } = useTranslation()
  const server = useApp(activeServerState)
  const [panel, setPanel] = useState<Panel>('none')
  const [joining, setJoining] = useState(false)
  useOpenJoinRequests(useCallback(() => setJoining(true), []))
  const [creating, setCreating] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const stage = useVoice((s) => s.stageOpen && s.session?.serverKey === server?.key && !s.session?.call && !s.session?.group)
  const stageChannel = useVoice((s) => s.session?.channelId)
  const isStageChannel = !!server?.channels.some((c) => c.id === stageChannel && c.kind === 'stage')
  const hasServers = useApp((s) => s.order.length > 0)
  const channelId = useApp(activeChannelId)
  const members = !!server && hasMembers(server)
  // The header's members button does nothing while there's no list (no empty drawer behind a scrim).
  const toggle = (p: Panel) => setPanel(panel === p || (p === 'members' && !members) ? 'none' : p)
  // Escape (and back) closes an open drawer (phones and narrow windows).
  useEscapeLayer(() => setPanel('none'), panel !== 'none', { kind: panel === 'nav' ? 'nav' : undefined })
  // Phones: back opens the channels, swipes move the drawers.
  const shellRef = useRef<HTMLDivElement>(null)
  const dragging = usePhoneNav(shellRef, panel, setPanel, !!server)

  return (
    <div ref={shellRef} className={`shell panel-${panel} ${members ? '' : 'no-members'} ${dragging ? `swiping swiping-${dragging}` : ''}`}>
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
        {server && <TeamsBar server={server} />}
        <KtNotices />
        <ErrorBoundary variant="pane" resetKey={`${server?.key ?? ''}:${channelId ?? ''}:${stage}`}>
          {server && stage ? (
            <VoiceRoom server={server}>
              {isStageChannel
                ? <StageView server={server} onToggle={toggle} />
                : <VoiceStage server={server} onToggle={toggle} />}
            </VoiceRoom>
          ) : server ? (
            <ChatArea server={server} onToggle={toggle} />
          ) : (
            // With no servers yet, the Friends page leads with how to join or start one.
            <HomeMain
              onToggle={toggle}
              start={hasServers ? undefined : <StartCard onJoin={() => setJoining(true)} onCreate={() => setCreating(true)} />}
            />
          )}
        </ErrorBoundary>
      </main>

      {server && members && (
        <aside className="members-column">
          <MemberList server={server} onClose={() => setPanel('none')} />
        </aside>
      )}

      <SoundToasts />
      <OuthookToast />
      <AfkToast />
      <WarnToast />
      <LfgToast />
      <TeamsLayer />
      <RoomLayer />
      <StreamerPill floating />
      <LfgLayer />
      {(panel !== 'none' || dragging) && <div className="scrim" style={dragging && panel === 'none' ? { opacity: 0 } : undefined} onClick={() => setPanel('none')} />}
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
      <RolePickerLayer />
      <ProductivityLayer />
      <ClipLayer />
      <RecordingLayer />
      <PopoutLayer />
      <QuietDigestCard />
      <AssistantLayer />
      {joining && <JoinDialog onClose={() => setJoining(false)} onCreate={() => { setJoining(false); setCreating(true) }} onClaim={() => { setJoining(false); setClaiming(true) }} />}
      {claiming && <ClaimServerDialog onClose={() => setClaiming(false)} />}
      {creating && (desktop ? <CreateServerDialog onClose={() => setCreating(false)} /> : <StartServerDialog onClose={() => setCreating(false)} onClaim={() => { setCreating(false); setClaiming(true) }} />)}
    </div>
  )
}

function StartCard({ onJoin, onCreate }: { onJoin: () => void; onCreate: () => void }) {
  const { t } = useTranslation()
  return (
    <section className="empty-state start-card" aria-labelledby="start-card-title">
      <span className="empty-icon" aria-hidden>
        <Spark size={34} />
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
