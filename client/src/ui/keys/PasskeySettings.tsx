// Settings → Security: passkeys that unlock the app lock (WebAuthn PRF, see platform/passkeys.ts).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { passkeyProblemKey } from './passkeyText'
import {
  addPasskeyLock, canUsePasskeys, checkPassphrase, confirmWithPasskey, defaultPasskeyName, removePasskeyLock, renamePasskeyLock, useLock,
  type PasskeyInfo,
} from '../../state/lock'
import { useApp } from '../../state/store'
import { Spinner } from '../bits'
import { intlLocale } from '../../i18n'
import './keys.css'

const dateLabel = (ms: number) => new Date(ms).toLocaleDateString(intlLocale(), { year: 'numeric', month: 'short', day: 'numeric' })

/** Before changing the lock: the current passphrase, or (without one) one of the passkeys. */
async function confirmLock(passphrase: string): Promise<boolean> {
  const { passphrase: hasPassphrase, passkeys } = useLock.getState()
  if (hasPassphrase) return checkPassphrase(passphrase)
  return passkeys.length ? confirmWithPasskey() : true
}

export function PasskeySettings() {
  const { t } = useTranslation()
  const passkeys = useLock((s) => s.passkeys)
  const hasPassphrase = useLock((s) => s.passphrase)
  const accountName = useApp((s) => s.profile?.name ?? '')
  const [mode, setMode] = useState<{ kind: 'idle' } | { kind: 'add' } | { kind: 'remove'; passkey: PasskeyInfo } | { kind: 'rename'; passkey: PasskeyInfo }>({ kind: 'idle' })
  const [name, setName] = useState('')
  const [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const available = canUsePasskeys()

  function reset(message: string | null = null) {
    setMode({ kind: 'idle' })
    setName('')
    setCurrent('')
    setBusy(false)
    setError(null)
    setDone(message)
  }

  async function run(task: () => Promise<string | null>) {
    setBusy(true)
    setError(null)
    try {
      const message = await task()
      if (message !== null) reset(message)
      else setBusy(false)
    } catch (e) {
      setError(t(passkeyProblemKey(e)))
      setBusy(false)
    }
  }

  const confirmed = async () => {
    if (await confirmLock(current)) return true
    setError(t(hasPassphrase ? 'keys.appLock.wrongCurrent' : 'keys.passkeys.wrong'))
    return false
  }

  const add = () => run(async () => {
    if (!(await confirmed())) return null
    await addPasskeyLock(name.trim() || defaultPasskeyName(), accountName)
    return t('keys.passkeys.added')
  })

  const remove = (passkey: PasskeyInfo) => run(async () => {
    if (!(await confirmed())) return null
    await removePasskeyLock(passkey.id)
    return t('keys.passkeys.removed')
  })

  const rename = (passkey: PasskeyInfo) => run(async () => {
    await renamePasskeyLock(passkey.id, name)
    return null
  }).then(() => reset())

  const needsPassphrase = hasPassphrase && mode.kind !== 'rename'
  const onlyLock = !hasPassphrase && passkeys.length === 1

  return (
    <div className="passkeys" data-testid="passkeys">
      <h3 className="h4">{t('keys.passkeys.title')}</h3>
      <p className="muted">{t('keys.passkeys.intro')}</p>
      {!available && <p className="muted small-text">{t('keys.passkeys.unavailable')}</p>}
      {passkeys.length > 0 && (
        <ul className="passkey-list">
          {passkeys.map((p) => (
            <li key={p.id} className="passkey-row" data-testid="passkey-row">
              <div className="passkey-meta">
                <strong>{p.name}</strong>
                <span className="muted small-text">
                  {t('keys.passkeys.addedOn', { date: dateLabel(p.created) })}
                  {p.lastUsed ? ` · ${t('keys.passkeys.lastUsed', { date: dateLabel(p.lastUsed) })}` : ''}
                </span>
              </div>
              {mode.kind === 'idle' && (
                <div className="copy-row">
                  <button className="button small" onClick={() => { setDone(null); setName(p.name); setMode({ kind: 'rename', passkey: p }) }}>{t('keys.passkeys.rename')}</button>
                  <button className="button small danger-outline" onClick={() => { setDone(null); setMode({ kind: 'remove', passkey: p }) }}>{t('keys.passkeys.remove')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {done && mode.kind === 'idle' && <p className="success-text" role="status">{done}</p>}
      {mode.kind === 'idle' && available && (
        <div className="copy-row">
          <button className="button" onClick={() => { setDone(null); setName(defaultPasskeyName()); setMode({ kind: 'add' }) }}>{t('keys.passkeys.add')}</button>
        </div>
      )}
      {mode.kind !== 'idle' && (
        <form className="key-lock-form" onSubmit={(e) => {
          e.preventDefault()
          if (mode.kind === 'add') void add()
          else if (mode.kind === 'remove') void remove(mode.passkey)
          else void rename(mode.passkey)
        }}>
          {mode.kind === 'remove' && <p className="muted">{t(onlyLock ? 'keys.passkeys.removeLast' : 'keys.passkeys.removeHint')}</p>}
          {mode.kind !== 'remove' && (
            <label className="field">
              <span>{t('keys.passkeys.name')}</span>
              <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} autoFocus={!needsPassphrase} />
            </label>
          )}
          {needsPassphrase && (
            <label className="field">
              <span>{t('keys.appLock.current')}</span>
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
            </label>
          )}
          {mode.kind === 'add' && !hasPassphrase && <p className="muted small-text">{t('keys.passkeys.noPassphraseHint')}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="copy-row">
            <button type="submit" className={`button ${mode.kind === 'remove' ? 'danger' : 'primary'}`}
              disabled={busy || (needsPassphrase && !current) || (mode.kind === 'rename' && !name.trim())}>
              {busy ? <><Spinner /> {mode.kind === 'add' ? t('keys.passkeys.adding') : ''}</>
                : mode.kind === 'add' ? t('keys.passkeys.continue') : mode.kind === 'remove' ? t('keys.passkeys.confirmRemove') : t('common.save')}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => reset()}>{t('common.cancel')}</button>
          </div>
        </form>
      )}
    </div>
  )
}
