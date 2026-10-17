// Desktop only: "Restore a server from backup". Pick the file and enter its passphrase, or get it back from a backup
// buddy (a friend's server) with the recovery code; it then runs on this computer.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop, type PickedBackup, type RestoredServer } from '../../platform/desktop'
import { normalizeRecoveryCode } from '../../state/buddies'
import { moveServer, useApp } from '../../state/store'
import { Modal, Spinner } from '../bits'
import '../settings/backup.css'
import '../settings/buddies.css'

export function RestoreServer({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const canBuddy = !!desktop?.host.restoreBuddy
  const [source, setSource] = useState<'file' | 'buddy'>('file')
  const [picked, setPicked] = useState<PickedBackup | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const buddyReady = address.trim().length > 0 && normalizeRecoveryCode(code) !== null
  const ready = source === 'file' ? !!picked && (!picked.encrypted || !!passphrase) : buddyReady

  async function pick() {
    setError(null)
    try {
      const file = await desktop?.host.pickBackup?.()
      if (file) {
        setPicked(file)
        setPassphrase('')
      }
    } catch (e) {
      setError(cleanError(e))
    }
  }

  async function restore() {
    if (!ready || busy) return
    const host = desktop?.host
    const run: (() => Promise<RestoredServer>) | null = source === 'file'
      ? (picked && host?.restore ? () => host.restore!(picked.path, passphrase) : null)
      : (host?.restoreBuddy ? () => host.restoreBuddy!(address.trim(), code) : null)
    if (!run) return
    setBusy(true)
    setError(null)
    try {
      const restored = await run()
      // Same server key as before: if it's already in your list (you're moving it), it just gets the new address.
      moveServer(restored.serverKey, restored.server.localUrl, restored.name)
      useApp.setState({ activeServer: restored.serverKey })
      onClose()
    } catch (e) {
      setError(cleanError(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('settings.restore.title')}
      onBack={onBack}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onBack}>{t('common.back')}</button>
          <button className="button primary" disabled={!ready || busy} onClick={() => void restore()}>
            {busy ? <Spinner /> : t('settings.restore.restore')}
          </button>
        </>
      }
    >
      {canBuddy && (
        <div className="restore-source" role="radiogroup" aria-label={t('settings.restore.title')}>
          {(['file', 'buddy'] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={source === s} className={`button ${source === s ? 'primary' : 'ghost'}`}
              disabled={busy} onClick={() => { setSource(s); setError(null) }}>
              {s === 'file' ? t('buddies.restore.fromFile') : t('buddies.restore.fromBuddy')}
            </button>
          ))}
        </div>
      )}
      {source === 'file' ? (
        <>
          <p className="muted">{t('settings.restore.intro')}</p>
          <div className="restore-file">
            <button className="button" onClick={() => void pick()} disabled={busy}>{picked ? t('settings.restore.pickAnother') : t('settings.restore.choose')}</button>
            {picked && (
              <span className="restore-file-name">
                <strong>{picked.name ?? picked.fileName}</strong>
                {picked.name && <span className="muted"> · {picked.fileName}</span>}
              </span>
            )}
          </div>
          {picked?.encrypted && (
            <label className="field">
              <span>{t('settings.restore.passphrase')}</span>
              <input type="password" autoFocus value={passphrase} maxLength={1024} disabled={busy}
                onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void restore()} />
            </label>
          )}
          {busy && <p className="muted">{t('settings.restore.busy')}</p>}
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void restore() }}>
          <p className="muted">{t('buddies.restore.intro')}</p>
          <label className="field">
            <span>{t('buddies.restore.address')}</span>
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://" maxLength={512} disabled={busy}
              spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          </label>
          <label className="field">
            <span>{t('buddies.restore.code')}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" maxLength={100} disabled={busy}
              spellCheck={false} autoCapitalize="characters" autoCorrect="off" className="restore-code" />
          </label>
          {busy && <p className="muted">{t('buddies.restore.busy')}</p>}
          <button type="submit" hidden />
        </form>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

/** Electron prefixes errors from the main process ("Error invoking remote method …: Error: …"). */
function cleanError(e: unknown): string {
  const message = (e as Error)?.message ?? String(e)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
