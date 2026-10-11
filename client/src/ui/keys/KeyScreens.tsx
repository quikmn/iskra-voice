// Screens and notices about this device's keys: the app lock, a replaced account key, disputes for admins.
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { fingerprint } from '../../core/connection'
import { encodeRecoveryKey, seedOf } from '../../core/recovery'
import { resetThisDevice } from '../../state/devices'
import { nameOf } from '../../state/dms'
import { reloadFriends } from '../../state/friends'
import { claimAccountBack, resolveDispute, retryRetired, useKeys } from '../../state/keys'
import { canUsePasskeys, unlock, unlockWithPasskey, useLock } from '../../state/lock'
import { passkeyProblemKey } from './PasskeySettings'
import { activeServerState, boot, useApp } from '../../state/store'
import { roleRank } from '../../core/protocol'
import { Modal, Spinner } from '../bits'
import { KeyActions } from '../dialogs/RecoveryKey'
import { errorMessage } from '../../i18n/errors'
import './keys.css'

/** The vault's own (English) startup errors, in the reader's language. */
const VAULT_ERRORS = {
  "Iskra's keys are protected by this computer's keychain, which isn't available right now.": 'keys.vault.keychainMissing',
  "This computer's keychain wouldn't unlock Iskra's keys. Make sure you're signed in as the same user, then try again.": 'keys.vault.keychainRefused',
  "The key that protects Iskra's data in this browser is missing or damaged.": 'keys.vault.browserKeyMissing',
} as const

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">⚡</span> Iskra
    </div>
  )
}

/** Clearing the device, with one confirmation step. */
function ResetButton({ label }: { label?: string }) {
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!confirm) return <button className="button wide" onClick={() => setConfirm(true)}>{label ?? t('keys.reset.button')}</button>
  return (
    <div className="key-confirm">
      <p className="warning-text">{t('keys.reset.warning')}</p>
      <div className="copy-row">
        <button className="button danger" disabled={busy} onClick={() => { setBusy(true); void resetThisDevice() }}>{t('keys.reset.confirm')}</button>
        <button className="button" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}

/** Startup: the app lock passphrase, or the keychain didn't cooperate. */
export function LockScreen() {
  const { t } = useTranslation()
  const status = useLock((s) => s.status)
  const message = useLock((s) => s.message)
  const hasPassphrase = useLock((s) => s.passphrase)
  const hasPasskeys = useLock((s) => s.passkeys.length > 0) && canUsePasskeys()
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [wrong, setWrong] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)

  async function withPasskey() {
    if (busy) return
    setBusy(true)
    setPasskeyError(null)
    try {
      if (!(await unlockWithPasskey())) throw new Error('wrong')
    } catch (e) {
      setPasskeyError(e instanceof Error && e.message === 'wrong' ? t('keys.passkeys.wrong') : t(passkeyProblemKey(e)))
      setBusy(false)
      return
    }
    await boot()
    await reloadFriends()
  }

  async function submit() {
    if (!passphrase || busy) return
    setBusy(true)
    setWrong(false)
    const ok = await unlock(passphrase)
    if (!ok) {
      setBusy(false)
      setWrong(true)
      return
    }
    await boot()
    await reloadFriends()
  }

  if (status === 'error') {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          <Brand />
          <p className="lead">{t('keys.lock.cantOpen')}</p>
          <p className="muted">{message && message in VAULT_ERRORS ? t(VAULT_ERRORS[message as keyof typeof VAULT_ERRORS]) : message}</p>
          <button className="button primary wide" onClick={() => window.location.reload()}>{t('common.tryAgain')}</button>
          <ResetButton />
        </div>
      </div>
    )
  }

  return (
    <div className="onboarding">
      <form className="onboarding-card" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <Brand />
        <p className="lead">{t('keys.lock.locked')}</p>
        {hasPasskeys && (
          <>
            <button type="button" className={`button wide ${hasPassphrase ? '' : 'primary'}`} disabled={busy} onClick={() => void withPasskey()}
              data-testid="unlock-passkey">
              {busy && !passphrase ? <><Spinner /> {t('keys.lock.unlocking')}</> : t('keys.passkeys.unlock')}
            </button>
            {passkeyError && <p className="error-text" role="alert">{passkeyError}</p>}
            {hasPassphrase && <div className="lock-or">{t('keys.passkeys.or')}</div>}
          </>
        )}
        {hasPassphrase && (
          <>
            <label className="field">
              <span>{t('keys.lock.passphrase')}</span>
              <input type="password" autoComplete="current-password" autoFocus={!hasPasskeys} value={passphrase} aria-invalid={wrong}
                onChange={(e) => { setPassphrase(e.target.value); setWrong(false) }} />
            </label>
            {wrong && <p className="error-text" role="alert">{t('keys.lock.wrong')}</p>}
            <button type="submit" className="button primary wide" disabled={!passphrase || busy}>
              {busy && passphrase ? <><Spinner /> {t('keys.lock.unlocking')}</> : t('keys.lock.unlock')}
            </button>
          </>
        )}
        {!hasPassphrase && !hasPasskeys && <p className="muted">{t('keys.passkeys.unavailable')}</p>}
        <details className="key-help">
          <summary>{t('keys.lock.forgot')}</summary>
          <p className="muted">{t(hasPassphrase ? 'keys.lock.forgotHint' : 'keys.passkeys.lostHint')}</p>
          <ResetButton />
        </details>
      </form>
    </div>
  )
}

/** This device's account key was replaced and it wasn't handed the new one. */
export function RetiredScreen() {
  const { t } = useTranslation()
  const [claiming, setClaiming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <Brand />
        <p className="lead">{t('keys.retired.title')}</p>
        <p className="muted">{t('keys.retired.body')}</p>
        <p className="muted">
          <Trans i18nKey="keys.retired.ifYou" components={{ b: <strong /> }} />
        </p>
        <button className="button wide" onClick={retryRetired}>{t('common.tryAgain')}</button>
        {claiming ? (
          <div className="key-confirm">
            <p>{t('keys.retired.claimHint')}</p>
            {error && <p className="error-text">{error}</p>}
            <div className="copy-row">
              <button className="button danger" disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try { await claimAccountBack() } catch (e) { setError(errorMessage(e)); setBusy(false) }
                }}>
                {t('keys.retired.claim')}
              </button>
              <button className="button" onClick={() => setClaiming(false)}>{t('common.cancel')}</button>
            </div>
          </div>
        ) : (
          <button className="button danger-outline wide" onClick={() => setClaiming(true)}>{t('keys.retired.notMe')}</button>
        )}
        <ResetButton />
      </div>
    </div>
  )
}

/** After this device moved to a new account key: the new recovery key, right away. */
export function NewKeyDialog() {
  const { t } = useTranslation()
  const moved = useKeys((s) => s.moved)
  const identity = useApp((s) => s.identity)
  if (!moved || !identity) return null
  const recoveryKey = encodeRecoveryKey(seedOf(identity))
  const close = () => useKeys.setState({ moved: null })
  return (
    <Modal title={t('keys.newKey.title')} onClose={close}>
      <p className="muted">
        {moved === 'here' ? t('keys.newKey.movedHere') : t('keys.newKey.movedElsewhere')}{' '}
        {t('keys.newKey.saveIt')}
      </p>
      <div className="recovery-key" data-testid="new-recovery-key">{recoveryKey}</div>
      <KeyActions recoveryKey={recoveryKey} />
      <p className="warning-text">{t('keys.newKey.warning')}</p>
      <button className="button primary" onClick={close}>{t('common.done')}</button>
    </Modal>
  )
}

/** Admins of the server you're looking at: someone's old key was claimed twice. */
export function DisputeNotices() {
  const { t } = useTranslation()
  const server = useApp(activeServerState)
  const disputes = useKeys((s) => s.disputes)
  const [busy, setBusy] = useState<string | null>(null)
  if (!server?.me || roleRank(server.me.role) < roleRank('admin')) return null
  const here = Object.values(disputes).flat().filter((d) => d.serverKey === server.key && d.rotation.contest && d.rotation.newKey !== server.me!.accountKey)
  if (here.length === 0) return null
  return (
    <>
      {here.map(({ rotation }) => {
        const name = nameOf(rotation.newKey)
        const decide = async (keep: string) => {
          setBusy(rotation.oldKey)
          await resolveDispute(server.key, rotation.oldKey, keep).catch(() => undefined)
          setBusy(null)
        }
        return (
          <div className="nudge key-dispute" role="status" key={rotation.oldKey}>
            <p>
              <Trans i18nKey="keys.dispute.body" values={{ name }} components={{ b: <strong /> }} />
            </p>
            <div className="copy-row">
              <button className="button small" disabled={busy === rotation.oldKey} onClick={() => void decide(rotation.newKey)}>
                {t('keys.dispute.keep', { key: fingerprint(rotation.newKey) })}
              </button>
              <button className="button small" disabled={busy === rotation.oldKey} onClick={() => void decide(rotation.contest!.newKey)}>
                {t('keys.dispute.giveTo', { key: fingerprint(rotation.contest!.newKey) })}
              </button>
            </div>
          </div>
        )
      })}
    </>
  )
}
