// Incoming webhooks, the extras (PROTOCOL.md "Webhook formats"): the format picker next to a fresh URL (GitHub, Gitea,
// GitLab and Slack suffixes) and the signing secret those services sign their posts with.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Webhook } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { setSigningSecret } from '../../state/invitetrack'
import '../invitetrack.css'
import { SIGNING_MAX, SIGNING_MIN, WEBHOOK_FORMATS, newSigningSecret, signingSecretProblem, type WebhookFormat } from '../../state/inviteTrackRules'

export function FormatPicker({ value, onChange }: { value: WebhookFormat; onChange: (f: WebhookFormat) => void }) {
  const { t } = useTranslation()
  return (
    <label className="field inline webhook-format">
      <span>{t('invitetrack.formats.label')}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as WebhookFormat)} data-testid="webhook-format">
        {WEBHOOK_FORMATS.map((f) => <option key={f} value={f}>{t(`invitetrack.formats.${f}`)}</option>)}
      </select>
      <small className="muted">{t('invitetrack.formats.hint')}</small>
    </label>
  )
}

/** Sets, replaces or removes a webhook's signing secret. The secret shows only while it's being set. */
export function SigningSecret({ serverKey, hook, onDone }: { serverKey: string; hook: Webhook; onDone: () => void }) {
  const { t } = useTranslation()
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = secret ? signingSecretProblem(secret) : null

  async function save(value: string) {
    setBusy(true)
    try {
      await setSigningSecret(serverKey, hook.id, value)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="secret-box webhook-signing" data-testid="webhook-signing">
      <strong>{t('invitetrack.signing.title', { name: hook.name })}</strong>
      <p className="muted">{t('invitetrack.signing.intro')}</p>
      <div className="copy-row">
        <input
          value={secret}
          maxLength={SIGNING_MAX}
          aria-label={t('invitetrack.signing.secret')}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setSecret(e.target.value)}
          data-testid="webhook-signing-input"
        />
        <button className="button" onClick={() => setSecret(newSigningSecret())}>{t('invitetrack.signing.generate')}</button>
        {secret && <button className="button" onClick={() => void navigator.clipboard.writeText(secret)}>{t('common.copy')}</button>}
      </div>
      {secret && <p className="muted">{t('invitetrack.signing.copyNow')}</p>}
      {problem && <p className="error-text">{t(`invitetrack.signing.${problem}`, { min: SIGNING_MIN, max: SIGNING_MAX })}</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="hook-actions">
        <button className="button primary" disabled={busy || !secret || problem !== null} onClick={() => void save(secret)}>{t('invitetrack.signing.save')}</button>
        {hook.signed && <button className="button danger-outline" disabled={busy} onClick={() => void save('')}>{t('invitetrack.signing.remove')}</button>}
        <button className="button" onClick={onDone}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}
