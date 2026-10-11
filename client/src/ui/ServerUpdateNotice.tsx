// A line above the chat: "Update available" for the owner, "restarting for an update" for everyone.
import { useState } from 'react'
import { updateNotice, useServerUpdates } from '../state/serverUpdates'
import type { ServerState } from '../state/store'
import { SettingsDialog } from './settings/SettingsDialog'
import './settings/updates.css'

const dismissedKey = (serverKey: string) => `iskra.server-update-dismissed.${serverKey}`

function readDismissed(serverKey: string): string | null {
  try {
    return localStorage.getItem(dismissedKey(serverKey))
  } catch {
    return null
  }
}

export function ServerUpdateNotice({ server }: { server: ServerState }) {
  const status = useServerUpdates((s) => s.status[server.key])
  const restarting = useServerUpdates((s) => s.restarting[server.key])
  const [dismissed, setDismissed] = useState<Record<string, string | null>>({})
  const [open, setOpen] = useState(false)
  const owner = server.me?.role === 'owner'
  const notice = owner ? updateNotice(status, server.key in dismissed ? dismissed[server.key] : readDismissed(server.key)) : null

  if (restarting) {
    return (
      <div className="nudge update-nudge" role="status" aria-live="polite">
        <p>{server.name} is restarting for an update to Iskra {restarting}. It’ll be back in a moment.</p>
      </div>
    )
  }
  if (!notice) return null

  function dismiss() {
    if (!notice) return
    setDismissed((d) => ({ ...d, [server.key]: notice.version }))
    try {
      localStorage.setItem(dismissedKey(server.key), notice.version)
    } catch {
      /* private mode */
    }
  }

  return (
    <>
      <div className="nudge update-nudge" role="status">
        <p>
          {notice.installing ? `Updating ${server.name} to Iskra ${notice.version}…` : `Update available for ${server.name}: Iskra ${notice.version}.`}{' '}
          <a href={notice.url} target="_blank" rel="noreferrer">What’s new</a>
        </p>
        <button className="button primary small" onClick={() => setOpen(true)}>Open Updates</button>
        {!notice.installing && <button className="button small" onClick={dismiss}>Later</button>}
      </div>
      {open && <SettingsDialog server={server} section="updates" onClose={() => setOpen(false)} />}
    </>
  )
}
