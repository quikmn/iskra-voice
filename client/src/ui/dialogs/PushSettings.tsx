import { useState } from 'react'
import { useNotify } from '../../state/notify'
import { currentPushSupport, disablePush, enablePush, installApp, useInstall, usePush } from '../../state/push'
import { useApp } from '../../state/store'

/** Push notifications while Iskra is closed, and installing the web app. Not shown in the desktop app. */
export function PushSettings() {
  const support = currentPushSupport()
  const wanted = useNotify((s) => s.push)
  const servers = usePush((s) => s.servers)
  const error = usePush((s) => s.error)
  const names = useApp((s) => s.servers)
  const installable = useInstall((s) => s.prompt !== null)
  const [busy, setBusy] = useState(false)
  if (support === 'desktop-app') return null

  const permission = typeof Notification === 'undefined' ? 'default' : Notification.permission
  const on = wanted && permission === 'granted'
  const failed = Object.entries(servers).filter(([, state]) => state === 'error').map(([key]) => names[key]?.name ?? 'a server')
  const active = Object.values(servers).filter((state) => state === 'on').length

  async function toggle(checked: boolean) {
    setBusy(true)
    try {
      await (checked ? enablePush() : disablePush())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="push-settings">
      {support === 'supported' && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={on} disabled={busy || permission === 'denied'} onChange={(e) => void toggle(e.target.checked)} />
            Push notifications on this device, even when Iskra is closed
          </label>
          {on && active > 0 && (
            <p className="muted push-status">
              On for {active === 1 ? '1 server' : `${active} servers`}: mentions, replies and direct messages.
            </p>
          )}
          {on && failed.length > 0 && (
            <p className="push-error" role="alert">
              Couldn't turn on push for {failed.join(', ')}{error ? ` (${error})` : ''}.
            </p>
          )}
        </>
      )}
      {support === 'needs-install' && (
        <p className="muted push-hint">
          To get notifications on iPhone or iPad, add Iskra to your Home Screen first: tap <strong>Share</strong>, then{' '}
          <strong>Add to Home Screen</strong>, and open Iskra from there.
        </p>
      )}
      {support === 'unsupported' && <p className="muted push-hint">This browser can't show notifications while Iskra is closed.</p>}
      {installable && (
        <div className="push-install">
          <span className="muted">Get Iskra as an app on this device.</span>
          <button className="button" onClick={() => void installApp()}>Install Iskra</button>
        </div>
      )}
    </div>
  )
}
