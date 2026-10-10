// Desktop only: "Restore a server from backup". Pick the file, enter its passphrase, and it runs on this computer.
import { useState } from 'react'
import { desktop, type PickedBackup } from '../../platform/desktop'
import { moveServer, useApp } from '../../state/store'
import { Modal, Spinner } from '../bits'
import '../settings/backup.css'

export function RestoreServer({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const [picked, setPicked] = useState<PickedBackup | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    if (!picked || !desktop?.host.restore || busy || (picked.encrypted && !passphrase)) return
    setBusy(true)
    setError(null)
    try {
      const restored = await desktop.host.restore(picked.path, passphrase)
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
      title="Restore a server from backup"
      onBack={onBack}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onBack}>Back</button>
          <button className="button primary" disabled={!picked || busy || (picked.encrypted && !passphrase)} onClick={() => void restore()}>
            {busy ? <Spinner /> : 'Restore'}
          </button>
        </>
      }
    >
      <p className="muted">
        Bring a server here from another computer: pick its backup (made in Settings → Backup &amp; move, or a daily backup from its
        folder). It runs on this computer while Iskra is open, with everything it had.
      </p>
      <div className="restore-file">
        <button className="button" onClick={() => void pick()} disabled={busy}>{picked ? 'Pick another file' : 'Choose backup file…'}</button>
        {picked && (
          <span className="restore-file-name">
            <strong>{picked.name ?? picked.fileName}</strong>
            {picked.name && <span className="muted"> · {picked.fileName}</span>}
          </span>
        )}
      </div>
      {picked?.encrypted && (
        <label className="field">
          <span>Passphrase</span>
          <input type="password" autoFocus value={passphrase} maxLength={1024} disabled={busy}
            onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void restore()} />
        </label>
      )}
      {busy && <p className="muted">Restoring and starting the server… this can take a minute for big servers.</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

/** Electron prefixes errors from the main process ("Error invoking remote method …: Error: …"). */
function cleanError(e: unknown): string {
  const message = (e as Error)?.message ?? String(e)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
