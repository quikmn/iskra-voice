import { useState } from 'react'
import { acceptInvite, completeOnboarding, useApp } from '../state/store'
import { hostOf } from './format'

export function Onboarding() {
  const pendingInvite = useApp((s) => s.pendingInvite)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!trimmed || busy) return
    setBusy(true)
    await completeOnboarding(trimmed)
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
        <button className="button primary wide" disabled={!trimmed || busy}>
          {pendingInvite ? 'Join' : 'Continue'}
        </button>
        <p className="fine-print">No email, no password. Your account is a key that stays on this device.</p>
      </form>
    </div>
  )
}
