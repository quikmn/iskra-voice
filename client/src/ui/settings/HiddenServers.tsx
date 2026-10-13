// My settings → Appearance → Hidden servers: servers taken off the rail with "Hide server", and a way to show them again.
import { useTranslation } from 'react-i18next'
import { setServerHidden, useRail } from '../../state/rail'
import { hiddenServers } from '../../state/railLogic'
import { useApp } from '../../state/store'
import { ServerTile } from './ServerTile'

export function HiddenServersSection() {
  const { t } = useTranslation()
  const layout = useRail((s) => s.layout)
  const order = useApp((s) => s.order)
  const servers = useApp((s) => s.servers)
  const hidden = hiddenServers(layout, order).filter((key) => servers[key])

  return (
    <section className="settings-section hidden-servers">
      <h2>{t('settings.hiddenServers.title')}</h2>
      <p className="muted">{t('settings.hiddenServers.intro')}</p>
      {hidden.length === 0 ? (
        <p className="empty-note">{t('settings.hiddenServers.empty')}</p>
      ) : (
        <ul className="blocked-list">
          {hidden.map((key) => (
            <li key={key}>
              <ServerTile server={servers[key]} size="small" />
              <span className="blocked-name"><strong>{servers[key].name}</strong></span>
              <button className="button small" onClick={() => setServerHidden(key, false)}>
                {t('settings.hiddenServers.show')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
