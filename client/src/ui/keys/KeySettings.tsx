// Settings: replacing the account key, and how this device protects its keys (app lock).
import { useEffect, useState } from 'react'
import { b64u } from '../../core/crypto'
import { fingerprint } from '../../core/connection'
import { refreshDevices, useDevices } from '../../state/devices'
import { rotateAccountKey } from '../../state/keys'
import { checkPassphrase, MIN_PASSPHRASE, setPassphrase, useLock } from '../../state/lock'
import { useApp } from '../../state/store'
import { Modal, Spinner } from '../bits'
import './keys.css'

export function RotateKeySection() {
  const identity = useApp((s) => s.identity)
  const [open, setOpen] = useState(false)
  if (!identity) return null
  return (
    <section className="settings-section">
      <h3>Account key</h3>
      <p className="muted">
        Your account ID is <code data-testid="account-id">{fingerprint(b64u(identity.account.publicKey))}</code>. If your recovery key leaked, or
        someone may have copied one of your devices, replace your account key: your servers move your account to a new key, the old key and
        old recovery key stop working, and your friends' apps follow.
      </p>
      <button className="button danger-outline" onClick={() => setOpen(true)}>Replace account key</button>
      {open && <RotateKeyDialog onClose={() => setOpen(false)} />}
    </section>
  )
}

function RotateKeyDialog({ onClose }: { onClose: () => void }) {
  const devices = useDevices((s) => s.devices)
  const loaded = useDevices((s) => s.loaded)
  const online = useApp((s) => Object.values(s.servers).filter((x) => x.status.state === 'online').length)
  const total = useApp((s) => s.order.length)
  const [keep, setKeep] = useState<Record<string, boolean>>({})
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => void refreshDevices(), [])

  const others = devices.filter((d) => !d.current)
  async function rotate() {
    setBusy(true)
    setError(null)
    try {
      await rotateAccountKey([...others.filter((d) => keep[d.deviceKey] ?? true).map((d) => d.deviceKey)])
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="Replace account key" onClose={busy ? () => undefined : onClose}>
      <p className="muted">
        This device makes a new account key and signs it over with the old one. Your servers move your account, roles and messages to it, and
        your friends see that your safety number changed.
      </p>
      {!loaded ? <Spinner /> : others.length > 0 && (
        <fieldset className="key-devices">
          <legend>Keep these devices signed in</legend>
          {others.map((d) => (
            <label key={d.deviceKey} className="checkbox">
              <input type="checkbox" checked={keep[d.deviceKey] ?? true} onChange={(e) => setKeep({ ...keep, [d.deviceKey]: e.target.checked })} />
              <span>{d.name}<span className="muted small-text"> · {d.platform ?? 'device'}</span></span>
            </label>
          ))}
          <p className="muted small-text">Untick any device you don't trust (lost, or possibly copied): it won't get the new key.</p>
        </fieldset>
      )}
      {online < total && (
        <p className="warning-text small-text">
          {total - online} of your servers {total - online === 1 ? "isn't" : "aren't"} connected. They get the new key the next time this device
          connects to them.
        </p>
      )}
      <label className="checkbox field">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        <span>I understand my old recovery key will stop working, and I'll save the new one.</span>
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="copy-row">
        <button className="button danger" disabled={!understood || busy || !loaded} onClick={() => void rotate()}>
          {busy ? <><Spinner /> Replacing…</> : 'Replace key'}
        </button>
        <button className="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

const PROTECTION: Record<string, string> = {
  keychain: "Your keys and messages on this device are encrypted with a key held by your computer's keychain, so a copy of Iskra's data folder is useless on another computer or user account.",
  browser: "Your keys and messages are encrypted with a key this browser keeps for Iskra and never shows to the page. That stops casual snooping in the stored data, but not someone who can use this browser or copies its whole profile. For real protection, set an app lock passphrase.",
  'browser-no-keyring': "This computer has no keyring (like GNOME Keyring or KWallet), so your keys are encrypted with a key kept in Iskra's own data. That stops casual snooping, but not someone who copies the data folder. Set an app lock passphrase for real protection.",
}

export function AppLockSection() {
  const protection = useLock((s) => s.protection)
  const hasPassphrase = useLock((s) => s.passphrase)
  const [mode, setMode] = useState<'idle' | 'set' | 'remove'>('idle')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function reset() {
    setMode('idle')
    setCurrent('')
    setNext('')
    setRepeat('')
    setBusy(false)
    setError(null)
  }

  async function save() {
    setError(null)
    if (mode === 'set' && next !== repeat) return setError("The passphrases don't match.")
    setBusy(true)
    try {
      if (hasPassphrase && !(await checkPassphrase(current))) throw new Error("Your current passphrase isn't right.")
      await setPassphrase(mode === 'remove' ? null : next)
      reset()
      setDone(mode === 'remove' ? 'App lock turned off.' : 'App lock passphrase saved.')
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h3>App lock</h3>
      {protection && <p className="muted" data-testid="key-protection">{PROTECTION[protection]}</p>}
      <p className="muted">
        With an app lock, Iskra asks for a passphrase every time it starts, and your keys and messages can't be read without it. If you forget it,
        you'll need your recovery key.
      </p>
      {done && mode === 'idle' && <p className="success-text">{done}</p>}
      {mode === 'idle' ? (
        <div className="copy-row">
          <button className="button" onClick={() => { setDone(null); setMode('set') }}>{hasPassphrase ? 'Change passphrase' : 'Set a passphrase'}</button>
          {hasPassphrase && <button className="button danger-outline" onClick={() => { setDone(null); setMode('remove') }}>Turn off app lock</button>}
        </div>
      ) : (
        <form className="key-lock-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
          {hasPassphrase && (
            <label className="field">
              <span>Current passphrase</span>
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
            </label>
          )}
          {mode === 'set' && (
            <>
              <label className="field">
                <span>New passphrase</span>
                <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} autoFocus={!hasPassphrase} />
              </label>
              <label className="field">
                <span>Repeat it</span>
                <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
              </label>
            </>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="copy-row">
            <button type="submit" className={`button ${mode === 'remove' ? 'danger' : 'primary'}`}
              disabled={busy || (mode === 'set' && next.length < MIN_PASSPHRASE) || (hasPassphrase && !current)}>
              {busy ? <Spinner /> : mode === 'remove' ? 'Turn off' : 'Save'}
            </button>
            <button type="button" className="button" disabled={busy} onClick={reset}>Cancel</button>
          </div>
          {mode === 'set' && <p className="muted small-text">At least {MIN_PASSPHRASE} characters. A few unrelated words work well.</p>}
        </form>
      )}
    </section>
  )
}
