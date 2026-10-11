// Phones in the browser: a one-time, dismissible "get the app" hint. iPhone/iPad → add to Home Screen (needed for
// notifications there), Android → the Android app, or the browser's own install.
import { useState } from 'react'
import { LINKS } from '../links'
import { desktop } from '../platform/desktop'
import { installApp, useInstall } from '../state/push'
import { Close } from './icons'
import { dismissHint, hintDismissed, installHintKind, type InstallHintKind } from './installHintKind'
import './install-hint.css'

function storage(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

function currentKind(): InstallHintKind | null {
  if (typeof navigator === 'undefined') return null
  const kind = installHintKind({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    referrer: document.referrer,
    desktopApp: !!desktop,
    automated: navigator.webdriver === true,
  })
  return kind && !hintDismissed(storage(), kind) ? kind : null
}

/** The iOS Share symbol (a box with an arrow out of it), so people can find the button. */
const ShareIcon = () => (
  <svg className="install-hint-share" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12" />
    <path d="m8 7 4-4 4 4" />
    <path d="M8 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2" />
  </svg>
)

/** `signedIn`: on iPhone the Home Screen app keeps its own sign-in, so say how to get in there. */
export function InstallHint({ signedIn }: { signedIn: boolean }) {
  const [kind, setKind] = useState(currentKind)
  const installable = useInstall((s) => s.prompt !== null)
  if (!kind) return null

  function dismiss() {
    if (kind) dismissHint(storage(), kind)
    setKind(null)
  }

  return (
    <aside className={signedIn ? 'install-hint in-app' : 'install-hint'} aria-label="Get the Iskra app">
      <img className="install-hint-icon" src="/icons/icon-192.png" alt="" width={40} height={40} />
      <div className="install-hint-text">
        {kind === 'ios' ? (
          <>
            <strong>Add Iskra to your Home Screen</strong>
            <span>
              Tap <ShareIcon /> <b>Share</b>, then <b>Add to Home Screen</b>. Notifications on iPhone only work from the Home
              Screen app.
              {signedIn && ' It signs in on its own: open it and tap "I already have Iskra".'}
            </span>
          </>
        ) : (
          <>
            <strong>Get the Iskra app</strong>
            <span>Notifications, voice and video, right from your home screen.</span>
            <div className="install-hint-actions">
              <a className="button primary" href={LINKS.androidApp} target="_blank" rel="noreferrer">
                Get the Android app
              </a>
              {installable && (
                <button className="button" onClick={() => void installApp().then(() => setKind(null))}>
                  Install
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <button className="icon-button" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
        <Close size={16} />
      </button>
    </aside>
  )
}
