import { useState } from 'react'
import { fingerprint } from '../../core/connection'
import { parseInvite, type InviteLink } from '../../core/invite'
import { acceptInvite, useApp } from '../../state/store'
import { Modal } from '../bits'
import { hostOf } from '../format'

/** Paste an invite link. */
export function JoinDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const invite = parseInvite(text)
  const showError = text.trim().length > 0 && !invite

  function join() {
    if (!invite) return
    acceptInvite(invite)
    onClose()
  }

  return (
    <Modal
      title="Join a server"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!invite} onClick={join}>Join</button>
        </>
      }
    >
      <label className="field">
        <span>Invite link</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && join()}
          placeholder="https://app.iskra.foo/#/join/…"
        />
      </label>
      {showError && <p className="error-text">That doesn't look like an Iskra invite link.</p>}
      {invite && <InviteSummary invite={invite} />}
    </Modal>
  )
}

/** Confirmation when someone opens an invite link while already set up. */
export function JoinPrompt({ invite }: { invite: InviteLink }) {
  const close = () => useApp.setState({ pendingInvite: null })
  return (
    <Modal
      title="You're invited"
      onClose={close}
      footer={
        <>
          <button className="button" onClick={close}>Not now</button>
          <button className="button primary" onClick={() => acceptInvite(invite)}>Join server</button>
        </>
      }
    >
      <InviteSummary invite={invite} />
    </Modal>
  )
}

function InviteSummary({ invite }: { invite: InviteLink }) {
  return (
    <div className="invite-summary">
      <div>
        <span className="label">Server</span>
        <strong>{hostOf(invite.serverUrl)}</strong>
      </div>
      <div>
        <span className="label">Server ID</span>
        <code>{fingerprint(invite.serverKey)}</code>
      </div>
      {invite.serverUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.|192\.168\.|10\.)/.test(invite.serverUrl) && (
        <p className="warning-text">This server doesn't use HTTPS, so your connection to it isn't encrypted.</p>
      )}
    </div>
  )
}
