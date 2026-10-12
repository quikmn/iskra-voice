// A line above the chat: "Update available" for the owner, "restarting for an update" for everyone.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { updateNotice, useServerUpdates } from '../state/serverUpdates'
import type { ServerState } from '../state/store'
import { openServerSettings } from './settings/open'
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
  const { t } = useTranslation()
  const status = useServerUpdates((s) => s.status[server.key])
  const restarting = useServerUpdates((s) => s.restarting[server.key])
  const [dismissed, setDismissed] = useState<Record<string, string | null>>({})
  const owner = server.me?.role === 'owner'
  const notice = owner ? updateNotice(status, server.key in dismissed ? dismissed[server.key] : readDismissed(server.key)) : null

  if (restarting) {
    // Once it's gone, the restart banner takes over.
    if (server.status.state !== 'online') return null
    return (
      <div className="nudge update-nudge" role="status" aria-live="polite">
        <p>{t('updates.notice.restarting', { server: server.name, version: restarting })}</p>
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
          {t(notice.installing ? 'updates.notice.installing' : 'updates.notice.available', { server: server.name, version: notice.version })}{' '}
          <a href={notice.url} target="_blank" rel="noreferrer">{t('updates.whatsNew')}</a>
        </p>
        <button className="button primary small" onClick={() => openServerSettings(server.key, 'updates')}>{t('updates.notice.open')}</button>
        {!notice.installing && <button className="button small" onClick={dismiss}>{t('updates.notice.later')}</button>}
      </div>
    </>
  )
}
