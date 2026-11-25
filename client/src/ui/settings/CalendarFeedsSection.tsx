// Server settings → Overview → Calendar links (owner only): whether members may make a private link that their
// calendar app fetches this server's events from. Allowed unless turned off.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { ServerState } from '../../state/store'
import { loadFeed, setFeedsAllowed, useCalendar } from '../../state/calendar'
import { SwitchRow } from '../kit'

export function CalendarFeedsSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const feed = useCalendar((s) => s.feeds[server.key])
  const [error, setError] = useState<string | null>(null)
  const owner = server.me?.role === 'owner'
  const online = server.status.state === 'online'

  useEffect(() => {
    if (!owner || !online) return
    setError(null)
    // A server that just moved answers `moved`: the app follows it, and this asks again once it's back online there.
    loadFeed(server.key).catch((e: unknown) => { if ((e as { code?: string } | null)?.code !== 'moved') setError(errorMessage(e)) })
  }, [server.key, server.directUrl, owner, online])

  // Nothing on a server too old to have feeds.
  if (!owner || !feed) return null
  return (
    <div className="calendar-feeds-settings" data-testid="calendar-feeds-section">
      <h3>{t('calendar.settings.title')}</h3>
      <SwitchRow
        title={t('calendar.settings.allow')} help={t('calendar.settings.help')} checked={feed.allowed} testId="calendar-feeds-allowed"
        onChange={(next) => {
          setError(null)
          setFeedsAllowed(server.key, next).catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
}
