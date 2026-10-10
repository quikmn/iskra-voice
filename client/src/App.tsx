import { useEffect } from 'react'
import { parseInvite } from './core/invite'
import { boot, retryAll, useApp } from './state/store'
import { loadFriends } from './state/dms'
import { startPushToTalk } from './state/voice'
import { startTitleBadge } from './state/notify'
import { ScreenPicker } from './ui/ScreenPicker'
import { Spinner } from './ui/bits'
import { JoinPrompt } from './ui/dialogs/JoinDialog'
import { Onboarding } from './ui/Onboarding'
import { Shell } from './ui/Shell'

/** Picks up "#/join/..." invite links, then clears them from the address bar. */
function readInviteFromHash(): void {
  if (!window.location.hash.startsWith('#/join/')) return
  const invite = parseInvite(window.location.hash)
  history.replaceState(null, '', window.location.pathname + window.location.search)
  if (invite) useApp.setState({ pendingInvite: invite })
}

let booted = false

export function App() {
  const phase = useApp((s) => s.phase)
  const pendingInvite = useApp((s) => s.pendingInvite)

  useEffect(() => {
    readInviteFromHash()
    if (!booted) {
      booted = true
      void boot().then(loadFriends)
    }
    window.addEventListener('hashchange', readInviteFromHash)
    window.addEventListener('online', retryAll)
    const stopPtt = startPushToTalk()
    const stopTitle = startTitleBadge()
    return () => {
      stopPtt()
      stopTitle()
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
  if (phase === 'onboarding') return <Onboarding />
  return (
    <>
      <Shell />
      {pendingInvite && <JoinPrompt invite={pendingInvite} />}
      <ScreenPicker />
    </>
  )
}
