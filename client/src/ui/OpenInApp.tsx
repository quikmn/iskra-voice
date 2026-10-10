// On an invite in the browser: open it in the desktop app instead, if it's installed.
import { appInviteLink, type InviteLink } from '../core/invite'
import { desktopOs } from '../links'
import { desktop } from '../platform/desktop'
import './desktop.css'

export function OpenInApp({ invite }: { invite: InviteLink }) {
  if (desktop || typeof navigator === 'undefined' || desktopOs(navigator.userAgent, navigator.platform, navigator.maxTouchPoints) === 'other') return null
  return (
    <p className="muted open-in-app">
      Have the Iskra app? <a href={appInviteLink(invite)}>Open in the app</a>
    </p>
  )
}
