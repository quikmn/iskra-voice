// Settings → Privacy & data: download what each server keeps about you, and what this device keeps; then who Iskra
// talks to besides your servers (ConnectionsSection).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { formatBytes } from '../../i18n/format'
import { downloadFile } from '../../state/backups'
import { collectDeviceExport, dateStamp, requestDataExport, saveJson } from '../../state/compliance'
import { useApp, type ServerState } from '../../state/store'
import { Spinner } from '../bits'
import { ConnectionsSection } from './ConnectionsSection'
import './compliance.css'

export function PrivacySection() {
  const { t } = useTranslation()
  const all = useApp((s) => s.servers)
  const order = useApp((s) => s.order)
  const servers = order.map((key) => all[key]).filter((server): server is ServerState => !!server?.me)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function fromServer(serverKey: string, name: string) {
    setBusy(serverKey)
    setError(null)
    setStatus(null)
    try {
      const made = await requestDataExport(serverKey)
      downloadFile(made.url)
      setStatus(t('compliance.privacy.ready', { server: name, size: formatBytes(made.size) }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function fromDevice() {
    setBusy('device')
    setError(null)
    setStatus(null)
    try {
      const name = `iskra-device-data-${dateStamp()}.json`
      saveJson(name, await collectDeviceExport())
      setStatus(t('compliance.privacy.deviceDone', { name }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
    <section className="settings-section" data-testid="privacy-section">
      <h2>{t('settings.sections.privacy')}</h2>
      <p className="muted">{t('compliance.privacy.intro')}</p>

      <h3 className="h4">{t('compliance.privacy.serversTitle')}</h3>
      <p className="muted">{t('compliance.privacy.serversHint')}</p>
      {servers.length === 0 ? (
        <p className="empty-note">{t('compliance.privacy.noServers')}</p>
      ) : (
        <ul className="data-export-list">
          {servers.map((server) => (
            <li key={server.key}>
              <span className="data-export-name">{server.name}</span>
              <button className="button small" disabled={busy !== null} onClick={() => void fromServer(server.key, server.name)}>
                {busy === server.key ? <Spinner /> : t('compliance.privacy.download')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="h4">{t('compliance.privacy.deviceTitle')}</h3>
      <p className="muted">{t('compliance.privacy.deviceHint')}</p>
      <button className="button" disabled={busy !== null} onClick={() => void fromDevice()}>
        {busy === 'device' ? <Spinner /> : t('compliance.privacy.deviceDownload')}
      </button>

      {status && <p className="muted" role="status">{status}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="muted data-export-note">{t('compliance.privacy.deleteHint')}</p>
    </section>
    <ConnectionsSection />
    </>
  )
}
