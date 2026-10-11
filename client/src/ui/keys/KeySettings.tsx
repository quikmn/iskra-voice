// Settings: replacing the account key, and how this device protects its keys (app lock).
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { b64u } from '../../core/crypto'
import { fingerprint } from '../../core/connection'
import { refreshDevices, useDevices } from '../../state/devices'
import { rotateAccountKey } from '../../state/keys'
import { checkPassphrase, confirmWithPasskey, MIN_PASSPHRASE, setPassphrase, useLock } from '../../state/lock'
import { useApp } from '../../state/store'
import { Modal, Spinner } from '../bits'
import { errorMessage } from '../../i18n/errors'
import { PasskeySettings } from './PasskeySettings'
import './keys.css'

export function RotateKeySection() {
  const { t } = useTranslation()
  const identity = useApp((s) => s.identity)
  const [open, setOpen] = useState(false)
  if (!identity) return null
  return (
    <section className="settings-section">
      <h3>{t('keys.rotate.title')}</h3>
      <p className="muted">
        <Trans i18nKey="keys.rotate.intro" values={{ id: fingerprint(b64u(identity.account.publicKey)) }}
          components={{ code: <code data-testid="account-id" /> }} />
      </p>
      <button className="button danger-outline" onClick={() => setOpen(true)}>{t('keys.rotate.button')}</button>
      {open && <RotateKeyDialog onClose={() => setOpen(false)} />}
    </section>
  )
}

function RotateKeyDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
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
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={t('keys.rotate.button')} onClose={busy ? () => undefined : onClose}>
      <p className="muted">{t('keys.rotate.dialogIntro')}</p>
      {!loaded ? <Spinner /> : others.length > 0 && (
        <fieldset className="key-devices">
          <legend>{t('keys.rotate.keepDevices')}</legend>
          {others.map((d) => (
            <label key={d.deviceKey} className="checkbox">
              <input type="checkbox" checked={keep[d.deviceKey] ?? true} onChange={(e) => setKeep({ ...keep, [d.deviceKey]: e.target.checked })} />
              <span>{d.name}{d.platform && d.platform !== d.name && <span className="muted small-text"> · {d.platform}</span>}</span>
            </label>
          ))}
          <p className="muted small-text">{t('keys.rotate.untick')}</p>
        </fieldset>
      )}
      {online < total && (
        <p className="warning-text small-text">
          {t('keys.rotate.offline', { count: total - online })}
        </p>
      )}
      <label className="checkbox field">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        {t('keys.rotate.understand')}
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="copy-row">
        <button className="button danger" disabled={!understood || busy || !loaded} onClick={() => void rotate()}>
          {busy ? <><Spinner /> {t('keys.rotate.replacing')}</> : t('keys.rotate.replace')}
        </button>
        <button className="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </Modal>
  )
}

const PROTECTION = {
  keychain: 'keys.protection.keychain',
  browser: 'keys.protection.browser',
  'browser-no-keyring': 'keys.protection.noKeyring',
} as const

export function AppLockSection() {
  const { t } = useTranslation()
  const protection = useLock((s) => s.protection)
  const hasPassphrase = useLock((s) => s.passphrase)
  const hasPasskeys = useLock((s) => s.passkeys.length > 0)
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
    if (mode === 'set' && next !== repeat) return setError(t('keys.appLock.mismatch'))
    setBusy(true)
    try {
      if (hasPassphrase && !(await checkPassphrase(current))) throw new Error(t('keys.appLock.wrongCurrent'))
      // Only passkeys so far: one of them confirms the change.
      if (!hasPassphrase && useLock.getState().passkeys.length > 0 && !(await confirmWithPasskey())) throw new Error(t('keys.passkeys.wrong'))
      await setPassphrase(mode === 'remove' ? null : next)
      reset()
      setDone(mode === 'remove' ? t(useLock.getState().passkeys.length ? 'keys.appLock.passphraseRemoved' : 'keys.appLock.turnedOff') : t('keys.appLock.saved'))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h3>{t('settings.sections.security')}</h3>
      {protection && <p className="muted" data-testid="key-protection">{t(PROTECTION[protection as keyof typeof PROTECTION])}</p>}
      <p className="muted">{t('keys.appLock.intro')}</p>
      {done && mode === 'idle' && <p className="success-text">{done}</p>}
      {mode === 'idle' ? (
        <div className="copy-row">
          <button className="button" onClick={() => { setDone(null); setMode('set') }}>{hasPassphrase ? t('keys.appLock.change') : t('keys.appLock.set')}</button>
          {hasPassphrase && <button className="button danger-outline" onClick={() => { setDone(null); setMode('remove') }}>{t(hasPasskeys ? 'keys.appLock.removePassphrase' : 'keys.appLock.turnOffButton')}</button>}
        </div>
      ) : (
        <form className="key-lock-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
          {hasPassphrase && (
            <label className="field">
              <span>{t('keys.appLock.current')}</span>
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
            </label>
          )}
          {mode === 'set' && (
            <>
              <label className="field">
                <span>{t('keys.appLock.new')}</span>
                <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} autoFocus={!hasPassphrase} />
              </label>
              <label className="field">
                <span>{t('keys.appLock.repeat')}</span>
                <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
              </label>
            </>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="copy-row">
            <button type="submit" className={`button ${mode === 'remove' ? 'danger' : 'primary'}`}
              disabled={busy || (mode === 'set' && next.length < MIN_PASSPHRASE) || (hasPassphrase && !current)}>
              {busy ? <Spinner /> : mode === 'remove' ? t(hasPasskeys ? 'keys.appLock.removePassphrase' : 'keys.appLock.turnOff') : t('common.save')}
            </button>
            <button type="button" className="button" disabled={busy} onClick={reset}>{t('common.cancel')}</button>
          </div>
          {mode === 'set' && <p className="muted small-text">{t('keys.appLock.minLength', { min: MIN_PASSPHRASE })}</p>}
        </form>
      )}
      <PasskeySettings />
    </section>
  )
}
