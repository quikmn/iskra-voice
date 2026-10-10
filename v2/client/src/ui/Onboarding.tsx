import { useState } from 'react'
import { decodeRecoveryKey } from '../core/recovery'
import { acceptInvite, completeOnboarding, restoreAccount, useApp } from '../state/store'
import { hostOf } from './format'

export function Onboarding() {
  const pendingInvite = useApp((s) => s.pendingInvite)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState('')
  const trimmed = name.trim()
  const seed = restoring ? decodeRecoveryKey(recoveryKey) : null
  const keyProblem = restoring && recoveryKey.trim().length > 20 && !seed

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!trimmed || busy || (restoring && !seed)) return
    setBusy(true)
    if (restoring && seed) await restoreAccount(seed, trimmed)
    else await completeOnboarding(trimmed)
    if (pendingInvite) acceptInvite(pendingInvite)
  }

  return (
    <div className="onboarding">
      <form className="onboarding-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">⚡</span> Iskra
        </div>
        {pendingInvite ? (
          <p className="lead">
            You've been invited to a server at <strong>{hostOf(pendingInvite.serverUrl)}</strong>.
            <br />
            Pick a name and you're in.
          </p>
        ) : (
          <p className="lead">Voice and text chat with your friends, on a server you own. Pick a name to get started.</p>
        )}
        {restoring && (
          <label className="field">
            <span>Recovery key</span>
            <textarea
              rows={3}
              value={recoveryKey}
              onChange={(e) => setRecoveryKey(e.target.value)}
              placeholder="ISKRA-XXXX-XXXX-…"
              spellCheck={false}
              autoComplete="off"
            />
            {keyProblem && <small className="error-text">That key doesn't check out. Look for a typo.</small>}
            {seed && <small className="success-text">Key looks right.</small>}
          </label>
        )}
        <label className="field">
          <span>Your name</span>
          <input
            autoFocus
            maxLength={32}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What should friends call you?"
          />
        </label>
        <button className="button primary wide" disabled={!trimmed || busy || (restoring && !seed)}>
          {restoring ? 'Restore my account' : pendingInvite ? 'Join' : 'Continue'}
        </button>
        <p className="fine-print">
          {restoring ? (
            <button type="button" className="link" onClick={() => setRestoring(false)}>I'm new here</button>
          ) : (
            <>
              No email, no password. Your account is a key that stays on this device.{' '}
              <button type="button" className="link" onClick={() => setRestoring(true)}>I already have an account</button>
            </>
          )}
        </p>
      </form>
    </div>
  )
}
