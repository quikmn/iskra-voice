import { useState } from 'react'
import { parseInvite } from '../../core/invite'
import { desktop } from '../../platform/desktop'
import { acceptInvite } from '../../state/store'
import { Modal, Spinner } from '../bits'
import { appUrl } from '../format'

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
        Your server runs on this computer while Iskra is open. Everything stays in a folder you own (Documents\Iskra\Servers), with voice
        included.
      </p>
      <label className="field">
        <span>Server name</span>
        <input autoFocus value={name} maxLength={60} placeholder="Game Night" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
      </label>
      <p className="muted">Friends on your network can join right away with an invite link. Playing over the internet needs one more step (HTTPS setup).</p>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
