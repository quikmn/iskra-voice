// My settings → Privacy & data: "Who Iskra talks to". Every connection the app makes to anyone but your own servers,
// when it happens, what they see and how to turn it off. The public version is docs/privacy-connections.md.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop, type DesktopSettings } from '../../platform/desktop'
import { setAlwaysLoad, siteName, useSiteConsent } from '../../state/siteConsent'

type Item = 'servers' | 'embeds' | 'watch' | 'gifs' | 'updates' | 'push' | 'webApp' | 'hosting'

const ITEMS: Item[] = ['servers', 'embeds', 'watch', 'gifs', 'updates', 'push', 'webApp', 'hosting']

export function ConnectionsSection() {
  const { t } = useTranslation()
  const sites = useSiteConsent((s) => s.sites)
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings | null>(null)

  useEffect(() => {
    let alive = true
    void desktop?.settings.get().then((s) => alive && setDesktopSettings(s))
    return () => {
      alive = false
    }
  }, [])

  async function setUpdateChecks(on: boolean) {
    if (!desktop || !desktopSettings) return
    setDesktopSettings({ ...desktopSettings, updateChecks: on })
    setDesktopSettings(await desktop.settings.set({ updateChecks: on }))
  }

  return (
    <section className="settings-section connections" data-testid="who-iskra-talks-to">
      <h3>{t('compliance.connections.title')}</h3>
      <p className="muted">{t('compliance.connections.intro')}</p>
      <ul className="connection-list">
        {ITEMS.map((item) => (
          <li key={item} className="connection" data-connection={item}>
            <strong>{t(`compliance.connections.${item}.who`)}</strong>
            <span>{t(`compliance.connections.${item}.when`)}</span>
            <span className="muted">{t(`compliance.connections.${item}.off`)}</span>
            {item === 'updates' && desktop && desktopSettings && (
              <label className="checkbox connection-switch">
                <input type="checkbox" checked={desktopSettings.updateChecks !== false} onChange={(e) => void setUpdateChecks(e.target.checked)} />
                <span>
                  {t('compliance.connections.updateChecks')}
                  <br /><small className="muted">{t('compliance.connections.updateChecksHint')}</small>
                </span>
              </label>
            )}
          </li>
        ))}
      </ul>
      <p className="muted">{t('compliance.connections.nothingElse')}</p>

      <h4>{t('compliance.connections.sitesTitle')}</h4>
      <p className="muted">{t('compliance.connections.sitesHint')}</p>
      <div data-testid="always-load-sites">
        {sites.length === 0 ? (
          <p className="empty-note">{t('compliance.connections.noSites')}</p>
        ) : (
          <ul className="data-export-list">
            {sites.map((site) => (
              <li key={site}>
                <span className="data-export-name">{siteName(site)}</span>
                <button className="button small" onClick={() => setAlwaysLoad(site, false)} aria-label={t('compliance.connections.forgetSite', { site: siteName(site) })}>
                  {t('compliance.connections.forget')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
