import { useEffect } from 'react'
import { parseInvite } from './core/invite'
import { boot, retryAll, useApp } from './state/store'
import { loadFriends } from './state/friends'
import { useDevices } from './state/devices'
import { usePendingLink } from './state/link'
import { AlreadySignedInNotice, RevokedScreen } from './ui/DeviceNotices'
import { startPushToTalk } from './state/voice'
import { startHotkeys } from './state/hotkeys'
import { startTitleBadge } from './state/notify'
import { startPush } from './state/push'
import { startPresenceWatch } from './state/presence'
import './state/moves'
import { startDesktopLinks } from './state/desktopShell'
import { ScreenPicker } from './ui/ScreenPicker'
import { Spinner } from './ui/bits'
import { JoinPrompt } from './ui/dialogs/JoinDialog'
import { Onboarding } from './ui/Onboarding'
import { Shell } from './ui/Shell'
import { UpdateToast } from './ui/UpdateToast'
import { InstallHint } from './ui/InstallHint'
import { LockScreen, NewKeyDialog, RetiredScreen } from './ui/keys/KeyScreens'
import { useKeys } from './state/keys'

/** Picks up "#/join/..." invite links and "#/link/..." device links, then clears them from the address bar. */
function readInviteFromHash(): void {
  if (window.location.hash.startsWith('#/link/')) {
    usePendingLink.setState({ code: window.location.hash })
    history.replaceState(null, '', window.location.pathname + window.location.search)
    return
  }
  if (!window.location.hash.startsWith('#/join/')) return
  const invite = parseInvite(window.location.hash)
  history.replaceState(null, '', window.location.pathname + window.location.search)
  if (invite) useApp.setState({ pendingInvite: invite })
}

let booted = false

export function App() {
  const phase = useApp((s) => s.phase)
  const pendingInvite = useApp((s) => s.pendingInvite)
  const revoked = useDevices((s) => s.thisDeviceRevoked)
  const retired = useKeys((s) => !!s.retired)

  useEffect(() => {
    readInviteFromHash()
    if (!booted) {
      booted = true
      void boot().then(loadFriends)
    }
    window.addEventListener('hashchange', readInviteFromHash)
    window.addEventListener('online', retryAll)
    const stopPtt = startPushToTalk()
    const stopHotkeys = startHotkeys()
    const stopTitle = startTitleBadge()
    const stopPush = startPush()
    const stopPresence = startPresenceWatch()
    const stopLinks = startDesktopLinks()
    return () => {
      stopLinks()
      stopPtt()
      stopHotkeys()
      stopTitle()
      stopPush()
      stopPresence()
      window.removeEventListener('hashchange', readInviteFromHash)
      window.removeEventListener('online', retryAll)
    }
  }, [])

  if (phase === 'loading') {
    return (
      <div className="onboarding">
        <Spinner />
      </div>
    )
  }
  if (phase === 'locked') return <LockScreen />
  if (phase === 'onboarding') {
    return (
      <>
        <Onboarding />
        <InstallHint signedIn={false} />
      </>
    )
  }
  if (revoked) return <RevokedScreen />
  if (retired) return <RetiredScreen />
  return (
    <>
      <Shell />
      <AlreadySignedInNotice />
      <NewKeyDialog />
      {pendingInvite && <JoinPrompt invite={pendingInvite} />}
      <ScreenPicker />
      <UpdateToast />
      <InstallHint signedIn />
    </>
  )
}
