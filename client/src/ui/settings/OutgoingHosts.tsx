// "Who Iskra talks to" → Outgoing webhooks: where each of your servers sends things (host and events, from the server).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { outgoingHosts, type ServerHosts } from '../../state/outhooks'

export function OutgoingHosts() {
  const { t } = useTranslation()
  const [servers, setServers] = useState<ServerHosts[] | null>(null)

  useEffect(() => {
    let alive = true
    void outgoingHosts().then((s) => alive && setServers(s))
    return () => {
      alive = false
    }
  }, [])

  if (servers === null) return null
  if (servers.length === 0) return <small className="muted" data-testid="outgoing-hosts">{t('compliance.connections.outgoingNone')}</small>
  return (
    <div className="outgoing-hosts" data-testid="outgoing-hosts">
      {servers.map((s) => (
        <div key={s.server}>
          <small className="muted">{t('compliance.connections.outgoingServer', { server: s.name })}</small>
          <ul>
            {s.hooks.map((h, i) => (
              <li key={i}>
                {t('compliance.connections.outgoingHook', {
                  host: h.host,
                  name: h.name,
                  events: h.events.map((e) => t(`outhooks.event.${e}`)).join(', '),
                })}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
