import { useState } from 'react'
import { parseInvite } from '../../core/invite'
import { desktop } from '../../platform/desktop'
import { acceptInvite } from '../../state/store'
import { Modal, Spinner } from '../bits'
import { appUrl } from '../format'

/** Where the desktop app keeps hosted servers (desktop/src/platform.ts). */
function hostFolder(): string {
  if (desktop?.platform === 'darwin') return '~/Library/Application Support/Iskra/Servers'
  return desktop?.platform === 'win32' ? 'Documents\\Iskra\\Servers' : '~/Documents/Iskra/Servers'
}

/** The one-time network prompt the OS shows when the server first listens. */
function firewallNote(): string | null {
  if (desktop?.platform === 'win32') return 'Windows may ask once to allow Iskra and its voice service on your network. Click Allow so friends can join.'
  if (desktop?.platform === 'darwin') return 'macOS may ask once to let Iskra accept incoming connections. Click Allow so friends can join.'
  return null
}

const ShieldIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </svg>
)

/** Desktop only: start a server on this computer and become its owner. */
export function CreateServerDialog({ onClose }: { onClose: () => void }) {
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
      if (!hosted || !invite) throw new Error("The server started but didn't hand out an owner link.")
      // You're on the same computer, so connect over localhost (it never changes).
      acceptInvite({ ...invite, serverUrl: hosted.localUrl })
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Create a server"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!trimmed || busy} onClick={() => void create()}>
            {busy ? <Spinner /> : 'Create'}
          </button>
        </>
      }
    >
      <p className="muted">
        Your server runs on this computer while Iskra is open. Everything stays in a folder you own ({hostFolder()}), with voice included.
      </p>
      <label className="field">
        <span>Server name</span>
        <input autoFocus value={name} maxLength={60} placeholder="Game Night" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
      </label>
      <p className="muted">
        Friends on your network can join right away with an invite link. For friends anywhere, turn on <strong>Open to the internet</strong> in the
        server's settings afterwards.
      </p>
      {firewallNote() && (
        <p className="dialog-note" role="note">
          <ShieldIcon />
          <span>{firewallNote()}</span>
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
