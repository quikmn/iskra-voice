import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { buildInviteLink } from '../../core/invite'
import type { Invite } from '../../core/protocol'
import { connectionFor, type ServerState } from '../../state/store'
import { inviteServerUrl, loadHostStatus, tailscaleServerUrl, useHostedHere, useHosting } from '../../state/hosting'
import { LIFETIMES, NEVER, inviteRequest, lifetimeChoices } from '../../state/inviteRules'
import { Modal, Spinner } from '../bits'
import { appUrl } from '../format'
import { InviteList } from './InviteList'

/** `via: 'tailscale'` starts on the invite for friends on Tailscale (when it's on where the server runs). */
export function InviteDialog({ server, onClose, via: initialVia = 'network' }: { server: ServerState; onClose: () => void; via?: 'network' | 'tailscale' }) {
  const { t } = useTranslation()
  const byUrl = useHostedHere((s) => s.byUrl)
  const status = useHosting((s) => s.status[server.key])
  const tailscaleUrl = tailscaleServerUrl(server, byUrl, status)
  const [via, setVia] = useState(initialVia)
  const overTailscale = via === 'tailscale' && tailscaleUrl !== null
  const admin = server.me?.role === 'owner' || server.me?.role === 'admin'

  // Admins: the server itself says whether Tailscale is on where it runs (for a server on another computer).
  useEffect(() => {
    if (admin && !status) loadHostStatus(server.key).catch(() => undefined)
  }, [admin, status, server.key])
  const [lifetime, setLifetime] = useState(LIFETIMES[2].ms)
  const [singleUse, setSingleUse] = useState(false)
  // One invite per combination of options, created on demand.
  const optionsKey = `${lifetime}:${singleUse}`
  const [invites, setInvites] = useState<Record<string, Invite>>({})
  const [error, setError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const invite = invites[optionsKey] ?? null
  const copied = copiedKey === optionsKey

  useEffect(() => {
    if (invites[optionsKey]) return
    let cancelled = false
    connectionFor(server.key)
      ?.request('invite.create', inviteRequest(lifetime, singleUse))
      .then((r) => !cancelled && setInvites((all) => ({ ...all, [optionsKey]: r.invite })))
      .catch((e: Error) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [server.key, lifetime, singleUse, optionsKey, invites])

  const serverUrl = overTailscale ? tailscaleUrl : inviteServerUrl(server)
  // With the p2p secret while the server lets friends connect without port forwarding (their desktop app uses it when the address can't be reached).
  const link = invite ? buildInviteLink(appUrl(server.appUrl), { serverUrl, serverKey: server.key, code: invite.code, ...(server.p2p ? { p2p: server.p2p } : {}) }) : ''

  // A revoked link the dialog shows is replaced by a fresh one.
  function dropRevoked(code: string) {
    setInvites((all) => Object.fromEntries(Object.entries(all).filter(([, i]) => i.code !== code)))
  }

  async function copy() {
    await navigator.clipboard.writeText(link)
    setCopiedKey(optionsKey)
  }

  return (
    <Modal title={t('settings.invite.title', { name: server.name })} onClose={onClose}>
      <p className="muted">{t('settings.invite.intro')}</p>
      {tailscaleUrl && (
        <div className="segmented" role="radiogroup" aria-label={t('hosting.tailscale.via')}>
          <button role="radio" aria-checked={!overTailscale} className={overTailscale ? '' : 'on'} onClick={() => setVia('network')}>
            {t('hosting.tailscale.viaNetwork')}
          </button>
          <button role="radio" aria-checked={overTailscale} className={overTailscale ? 'on' : ''} onClick={() => setVia('tailscale')} data-testid="invite-via-tailscale">
            {t('hosting.tailscale.viaTailscale')}
          </button>
        </div>
      )}
      {overTailscale && <p className="muted">{t('hosting.tailscale.inviteNote')}</p>}
      {server.p2p && !overTailscale && <p className="muted" data-testid="invite-p2p-note">{t('hosting.p2p.inviteNote')}</p>}
      <div className="copy-row">
        <input readOnly value={link} placeholder={t('settings.invite.creating')} onFocus={(e) => e.target.select()} />
        <button className="button primary" onClick={() => void copy()} disabled={!invite}>
          {invite ? (copied ? t('settings.recovery.copied') : t('common.copy')) : <Spinner />}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="options-row">
        <label className="field inline">
          <span>{t('settings.invite.expiresAfter')}</span>
          <select value={lifetime} data-testid="invite-expiry" onChange={(e) => setLifetime(Number(e.target.value))}>
            {lifetimeChoices(admin).map((l) => (
              <option key={l.ms} value={l.ms}>
                {l.ms === NEVER ? t('settings.invite.never')
                  : l.hours ? t('settings.invite.hours', { count: l.hours }) : t('settings.invite.days', { count: l.days ?? 0 })}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={singleUse} onChange={(e) => setSingleUse(e.target.checked)} />
          {t('settings.invite.singleUse')}
        </label>
      </div>
      {invite && invite.expiresAt === null && <p className="muted invite-never-note">{t('settings.invite.neverNote')}</p>}
      <InviteList server={server} current={invite?.code ?? null} refresh={invite?.code} onRevoked={dropRevoked} />
    </Modal>
  )
}
