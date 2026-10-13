// A first join that didn't get through: say why, and offer to try again or remove it (it isn't kept otherwise).
// A device restored from the recovery key whose account isn't on this server yet picks its name here.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../i18n/errors'
import { updateProfile } from '../state/profile'
import { leaveServer, rejoinServer, retryServer, type ServerState } from '../state/store'
import { WifiOff } from './icons'

export function JoinFailed({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const { status } = server
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  let host = server.url
  try {
    host = new URL(server.url).host
  } catch { /* shown as given */ }

  if (status.state === 'rejected' && status.code === 'name_required') {
    const pick = async (e: React.FormEvent) => {
      e.preventDefault()
      if (!name.trim() || busy) return
      setBusy(true)
      try {
        await updateProfile({ name: name.trim() })
        await rejoinServer(server.key)
      } finally {
        setBusy(false)
      }
    }
    return (
      <form className="empty-state join-failed" onSubmit={pick}>
        <h1>{t('chat.view.pickNameTitle')}</h1>
        <p>{t('chat.view.pickNameHint')}</p>
        <label className="field join-name">
          <span>{t('app.onboarding.yourName')}</span>
          <input autoFocus maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="join-failed-actions">
          <button className="button primary" disabled={!name.trim() || busy}>{t('common.join')}</button>
          <button type="button" className="button" onClick={() => leaveServer(server.key)}>{t('common.remove')}</button>
        </div>
      </form>
    )
  }

  return (
    <div className="empty-state join-failed" role="alert">
      <span className="empty-icon"><WifiOff size={32} /></span>
      <h1>{t('chat.view.joinFailedTitle')}</h1>
      <p>{status.state === 'rejected' ? errorMessage(status) : t('chat.view.joinFailed', { host })}</p>
      <div className="join-failed-actions">
        {status.state !== 'rejected' && <button className="button primary" onClick={() => retryServer(server.key)}>{t('common.tryAgain')}</button>}
        <button className="button" onClick={() => leaveServer(server.key)}>{t('common.remove')}</button>
      </div>
    </div>
  )
}
