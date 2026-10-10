import { useEffect, useState } from 'react'
import { buildInviteLink } from '../../core/invite'
import type { Invite } from '../../core/protocol'
import { connectionFor, type ServerState } from '../../state/store'
import { Modal, Spinner } from '../bits'
import { appUrl } from '../format'

const LIFETIMES = [
  { label: '1 hour', ms: 3600_000 },
  { label: '1 day', ms: 24 * 3600_000 },
  { label: '7 days', ms: 7 * 24 * 3600_000 },
  { label: '30 days', ms: 30 * 24 * 3600_000 },
]

export function InviteDialog({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const [lifetime, setLifetime] = useState(LIFETIMES[2].ms)
  const [singleUse, setSingleUse] = useState(false)
  // One invite per combination of options, created on demand.
  const optionsKey = `${lifetime}:${singleUse}`
  const [invites, setInvites] = useState<Record<string, Invite>>({})
  const [error, setError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const invite = invites[optionsKey] ?? null
  const copied = copiedKey === optionsKey

  useEffect(() => {
    if (invites[optionsKey]) return
    let cancelled = false
    connectionFor(server.key)
      ?.request('invite.create', { expiresInMs: lifetime, maxUses: singleUse ? 1 : undefined })
      .then((r) => !cancelled && setInvites((all) => ({ ...all, [optionsKey]: r.invite })))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [server.key, lifetime, singleUse, optionsKey, invites])

  const link = invite ? buildInviteLink(appUrl(), { serverUrl: server.url, serverKey: server.key, code: invite.code }) : ''

  async function copy() {
    await navigator.clipboard.writeText(link)
    setCopiedKey(optionsKey)
  }

  return (
    <Modal title={`Invite friends to ${server.name}`} onClose={onClose}>
      <p className="muted">Send this link to a friend. Opening it lets them pick a name and join.</p>
      <div className="copy-row">
        <input readOnly value={link} placeholder="Creating link…" onFocus={(e) => e.target.select()} />
        <button className="button primary" onClick={() => void copy()} disabled={!invite}>
          {invite ? (copied ? 'Copied!' : 'Copy') : <Spinner />}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="options-row">
        <label className="field inline">
          <span>Expires after</span>
          <select value={lifetime} onChange={(e) => setLifetime(Number(e.target.value))}>
            {LIFETIMES.map((l) => <option key={l.ms} value={l.ms}>{l.label}</option>)}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={singleUse} onChange={(e) => setSingleUse(e.target.checked)} />
          Single use
        </label>
      </div>
    </Modal>
  )
}
