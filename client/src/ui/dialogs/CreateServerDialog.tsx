import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { t } from '../../i18n'
import { errorMessage } from '../../i18n/errors'
import { parseInvite } from '../../core/invite'
import { desktop } from '../../platform/desktop'
import { acceptInvite } from '../../state/store'
import { RestoreServer } from './RestoreServer'
import '../settings/backup.css'
import { Modal, Spinner } from '../bits'
import { appUrl } from '../format'

/** Where the desktop app keeps hosted servers (desktop/src/platform.ts). */
function hostFolder(): string {
  if (desktop?.platform === 'darwin') return '~/Library/Application Support/Iskra/Servers'
  return desktop?.platform === 'win32' ? 'Documents\\Iskra\\Servers' : '~/Documents/Iskra/Servers'
}

/** The one-time network prompt the OS shows when the server first listens. */
function firewallNote(): string | null {
  if (desktop?.platform === 'win32') return t('settings.createServer.firewallWindows')
  if (desktop?.platform === 'darwin') return t('settings.createServer.firewallMac')
  return null
}

const ShieldIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </svg>
)

/** Desktop only: start a server on this computer and become its owner. */
export function CreateServerDialog({ onClose }: { onClose: () => void }) {
  const [restoring, setRestoring] = useState(false)
  if (restoring) return <RestoreServer onBack={() => setRestoring(false)} onClose={onClose} />
  return <NewServer onClose={onClose} onRestore={desktop?.host.pickBackup ? () => setRestoring(true) : undefined} />
}

function NewServer({ onClose, onRestore }: { onClose: () => void; onRestore?: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()

  async function create() {
    if (!desktop || !trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const hosted = await desktop.host.create(trimmed, appUrl())
      const invite = hosted?.ownerInvite ? parseInvite(hosted.ownerInvite) : null
      if (!hosted || !invite) throw new Error(t('settings.createServer.noOwnerLink'))
      // You're on the same computer, so connect over localhost (it never changes).
      acceptInvite({ ...invite, serverUrl: hosted.localUrl })
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('settings.createServer.title')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!trimmed || busy} onClick={() => void create()}>
            {busy ? <Spinner /> : t('common.create')}
          </button>
        </>
      }
    >
      <p className="muted">{t('settings.createServer.intro', { folder: hostFolder() })}</p>
      <label className="field">
        <span>{t('settings.createServer.name')}</span>
        <input autoFocus value={name} maxLength={60} placeholder={t('settings.createServer.namePlaceholder')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
      </label>
      <p className="muted">
        <Trans i18nKey="settings.createServer.network" components={{ b: <strong /> }} />
      </p>
      {firewallNote() && (
        <p className="dialog-note" role="note">
          <ShieldIcon />
          <span>{firewallNote()}</span>
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      {onRestore && (
        <p className="muted restore-link">
          {t('settings.createServer.moving')} <button className="link" onClick={onRestore}>{t('settings.createServer.restore')}</button>
        </p>
      )}
    </Modal>
  )
}
