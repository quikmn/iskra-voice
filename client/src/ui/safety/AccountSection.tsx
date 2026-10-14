// Settings → My account → Account (deleting your account) and About & legal (terms, privacy, support, safety contact).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { b64u } from '../../core/crypto'
import { errorMessage } from '../../i18n/errors'
import { LINKS } from '../../links'
import { native } from '../../platform/native'
import { deleteAccount, deletionPlan, transferOwnership } from '../../state/accountDeletion'
import { leaveServer, useApp } from '../../state/store'
import { LEGAL_LINKS, safetyMailto, SAFETY_EMAIL, useTerms } from '../../state/terms'
import { Modal, Spinner } from '../bits'
import { SignOutSection } from '../dialogs/SignOut'
import { fullTime } from '../format'
import { openBugReport } from '../../state/bugReport/bugReport'
import { BuildVersion } from './BuildVersion'
import './safety.css'

export function AccountSection() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.account')}</h2>
      <SignOutSection />
      <div className="settings-danger">
        <div>
          <strong>{t('safety.deleteAccount.title')}</strong>
          <p className="muted">{t('safety.deleteAccount.hint')}</p>
        </div>
        <button className="button danger-outline" onClick={() => setOpen(true)}>{t('safety.deleteAccount.button')}</button>
      </div>
      <p className="muted">
        {t('safety.deleteAccount.moreInfo')}{' '}
        <a href={LEGAL_LINKS.deleteAccount} target="_blank" rel="noreferrer">{LEGAL_LINKS.deleteAccount.replace('https://', '')}</a>
      </p>
      {open && <DeleteAccountDialog onClose={() => setOpen(false)} />}
    </section>
  )
}

const CONFIRM_WORD = 'DELETE'

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const servers = useApp((s) => s.servers)
  useApp((s) => s.order) // the plan follows the server list
  const plan = deletionPlan()
  const [messages, setMessages] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = plan.owned.length === 0 && typed.trim().toUpperCase() === CONFIRM_WORD

  async function run() {
    setBusy(true)
    setError(null)
    try {
      await deleteAccount({ messages }) // wipes this device and restarts the app
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={t('safety.deleteAccount.title')} onClose={busy ? () => undefined : onClose} className="delete-account-modal">
      <p>{t('safety.deleteAccount.intro')}</p>
      <ul className="delete-account-list">
        <li>{t('safety.deleteAccount.removes')}</li>
        <li>{t('safety.deleteAccount.devices')}</li>
        <li>{t('safety.deleteAccount.dms')}</li>
        <li>{t('safety.deleteAccount.noUndo')}</li>
      </ul>

      {plan.owned.length > 0 && (
        <div className="delete-owned" role="alert">
          <strong>{t('safety.deleteAccount.ownedTitle')}</strong>
          <p>{t('safety.deleteAccount.ownedHint')}</p>
          {plan.owned.map((key) => <OwnedServer key={key} serverKey={key} />)}
        </div>
      )}
      {plan.unreachable.length > 0 && (
        <p className="delete-unreachable">
          {t('safety.deleteAccount.unreachable', { servers: plan.unreachable.map((k) => servers[k]?.name ?? k).join(', ') })}
        </p>
      )}

      <label className="checkbox delete-messages">
        <input type="checkbox" checked={messages} onChange={(e) => setMessages(e.target.checked)} />
        <span>
          {t('safety.deleteAccount.alsoMessages')}
          <small className="muted">{t('safety.deleteAccount.alsoMessagesHint')}</small>
        </span>
      </label>

      <label className="field">
        <span>{t('safety.deleteAccount.typeToConfirm', { word: CONFIRM_WORD })}</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} placeholder={CONFIRM_WORD} />
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="sign-out-actions">
        <button className="button danger" disabled={!ready || busy} onClick={() => void run()}>
          {busy ? <><Spinner /> {t('safety.deleteAccount.busy')}</> : t('safety.deleteAccount.confirm')}
        </button>
        <button className="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </Modal>
  )
}

/** A server you own: hand it to someone, or (if you're shutting it down) take it off this app. */
function OwnedServer({ serverKey }: { serverKey: string }) {
  const { t } = useTranslation()
  const server = useApp((s) => s.servers[serverKey])
  const identity = useApp((s) => s.identity)
  const myKey = identity ? b64u(identity.account.publicKey) : ''
  const candidates = Object.values(server?.members ?? {}).filter((m) => m.accountKey !== myKey && !m.bot).sort((a, b) => a.name.localeCompare(b.name))
  const [to, setTo] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!server) return null
  const pickedName = candidates.find((m) => m.accountKey === to)?.name ?? ''
  return (
    <div className="delete-owned-server">
      <strong>{server.name}</strong>
      {server.status.state !== 'online' ? <p className="muted">{t('safety.deleteAccount.ownedOffline')}</p> : candidates.length > 0 && (
        <div className="copy-row">
          <select value={to} onChange={(e) => { setTo(e.target.value); setConfirm(false) }} aria-label={t('safety.transfer.to')}>
            <option value="">{t('safety.transfer.pick')}</option>
            {candidates.map((m) => <option key={m.accountKey} value={m.accountKey}>{m.name}</option>)}
          </select>
          {confirm ? (
            <button className="button danger small" onClick={() => transferOwnership(serverKey, to).catch((e) => setError(errorMessage(e)))}>
              {t('safety.transfer.confirm', { name: pickedName })}
            </button>
          ) : (
            <button className="button small" disabled={!to} onClick={() => setConfirm(true)}>{t('safety.transfer.button')}</button>
          )}
        </div>
      )}
      <p className="muted">
        {t('safety.deleteAccount.orShutDown')}{' '}
        <button className="link" onClick={() => leaveServer(serverKey)}>{t('safety.deleteAccount.removeFromApp')}</button>
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  )
}

/** Tip links: on the web and in the desktop app, not in the phone apps (App Store and Play payment rules). */
function tipsAllowed(): boolean {
  if (native) return false
  try {
    return !document.referrer.startsWith('android-app://') // the Android app (Trusted Web Activity)
  } catch {
    return true
  }
}

export function AboutSection() {
  const { t } = useTranslation()
  const accepted = useTerms((s) => s.accepted)
  return (
    <section className="settings-section about-section">
      <h2>{t('settings.sections.about')}</h2>
      <BuildVersion />
      <div className="about-bug">
        <div>
          <strong>{t('bugReport.open')}</strong>
          <p className="muted">{t('bugReport.where')}</p>
        </div>
        <button className="button" onClick={openBugReport}>{t('bugReport.open')}</button>
      </div>
      <ul className="legal-links">
        <li><a href={LEGAL_LINKS.terms} target="_blank" rel="noreferrer">{t('safety.links.terms')}</a></li>
        <li><a href={LEGAL_LINKS.privacy} target="_blank" rel="noreferrer">{t('safety.links.privacy')}</a></li>
        <li><a href={LEGAL_LINKS.support} target="_blank" rel="noreferrer">{t('safety.links.support')}</a></li>
        <li><a href={LEGAL_LINKS.deleteAccount} target="_blank" rel="noreferrer">{t('safety.links.deleteAccount')}</a></li>
      </ul>
      {accepted && <p className="muted">{t('safety.about.accepted', { version: accepted.version, when: fullTime(accepted.at) })}</p>}
      <div className="settings-danger about-safety">
        <div>
          <strong>{t('safety.links.reportToTeam')}</strong>
          <p className="muted">{t('safety.about.safetyHint', { email: SAFETY_EMAIL })}</p>
        </div>
        <a className="button" href={safetyMailto(t('safety.report.mailSubject'))}>{t('safety.about.email')}</a>
      </div>
      {tipsAllowed() && (
        <div className="about-support">
          <strong>{t('safety.about.supportTitle')}</strong>
          <p className="muted">{t('safety.about.supportHint')}</p>
          <div className="about-support-links">
            <a className="button" href={LINKS.kofi} target="_blank" rel="noreferrer">{t('safety.about.kofi')}</a>
            <a className="button" href={LINKS.paypal} target="_blank" rel="noreferrer">{t('safety.about.paypal')}</a>
          </div>
        </div>
      )}
    </section>
  )
}
