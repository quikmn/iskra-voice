// Server settings → Overview: "Save this server as a template", a JSON file to start other servers like this one.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { exportTemplate, saveTemplateFile, templateFileName } from '../../state/templates'
import { isAdmin } from '../../state/permissions'
import type { ServerState } from '../../state/store'

export function SaveAsTemplate({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!isAdmin(server.me)) return null

  async function save() {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await saveTemplateFile(await exportTemplate(server.key), templateFileName(server.name))
      setStatus(t('templates.save.done'))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="save-template" data-testid="save-template">
      <h3 className="h4">{t('templates.save.title')}</h3>
      <p className="muted">{t('templates.save.intro')}</p>
      <div className="copy-row">
        <button className="button" disabled={busy} onClick={() => void save()}>{t('templates.save.button')}</button>
        {status && <span className="muted" role="status">{status}</span>}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
