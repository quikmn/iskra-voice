import { useState } from 'react'
import { decodeRecoveryKey } from '../core/recovery'
import { usePendingLink } from '../state/link'
import { acceptInvite, completeOnboarding, restoreAccount, useApp } from '../state/store'
import { hostOf } from './format'
import { OpenInApp } from './OpenInApp'
import { LinkJoin } from './LinkJoin'

type Mode = 'new' | 'existing' | 'recovery' | 'link'

export function Onboarding() {
  const pendingInvite = useApp((s) => s.pendingInvite)
  const pendingLink = usePendingLink((s) => s.code)
  const [mode, setMode] = useState<Mode>(pendingLink ? 'link' : 'new')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState('')
  const restoring = mode === 'recovery'
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

  const brand = (
    <div className="brand">
      <span className="brand-mark">⚡</span> Iskra
    </div>
  )

  if (mode === 'link') {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          {brand}
          <LinkJoin initialCode={pendingLink} onBack={() => { usePendingLink.setState({ code: null }); setMode('existing') }} />
        </div>
      </div>
    )
  }

  if (mode === 'existing') {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          {brand}
          <p className="lead">Welcome back! How do you want to sign in?</p>
          <div className="choice-list">
            <button type="button" className="choice" onClick={() => setMode('link')}>
              <strong>Link with my other device</strong>
              <span className="muted">Scan a code from Iskra on your phone or computer. Easiest.</span>
            </button>
            <button type="button" className="choice" onClick={() => setMode('recovery')}>
              <strong>Use my recovery key</strong>
              <span className="muted">The ISKRA-… key you saved.</span>
            </button>
          </div>
          <p className="fine-print">
            <button type="button" className="link" onClick={() => setMode('new')}>I'm new here</button>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="onboarding">
      <form className="onboarding-card" onSubmit={submit}>
        {brand}
        {pendingInvite ? (
          <>
            <p className="lead">
              You've been invited to a server at <strong>{hostOf(pendingInvite.serverUrl)}</strong>.
              <br />
              Pick a name and you're in.
            </p>
            <OpenInApp invite={pendingInvite} />
          </>
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
            <button type="button" className="link" onClick={() => setMode('existing')}>Back</button>
          ) : (
            <>
              No email, no password. Your account is a key that stays on your devices.{' '}
              <button type="button" className="link" onClick={() => setMode('existing')}>I already have Iskra</button>
            </>
          )}
        </p>
      </form>
    </div>
  )
}
