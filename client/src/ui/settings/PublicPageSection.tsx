// Server settings → Overview → Public page (owner only): what a browser sees at this server's own address. Off by
// default; each thing the page shows is its own choice. The server renders the page; this only changes its settings.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Invite } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { useInvitesPaused } from '../../state/joins'
import { LANDING_DESCRIPTION_MAX, landingInviteChoices, landingUrl, loadLanding, updateLanding, useLandingSettings } from '../../state/landing'
import { connectionFor, type ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './landing.css'

export function PublicPageSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const settings = useLandingSettings(server.key)
  const paused = useInvitesPaused(server.key)
  const [invites, setInvites] = useState<Invite[]>([])
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const owner = server.me?.role === 'owner'

  useEffect(() => {
    if (!owner) return
    loadLanding(server.key).catch((e: unknown) => setError(errorMessage(e)))
    connectionFor(server.key)?.request('invite.list', {}).then((r) => setInvites(r.invites), () => undefined)
  }, [server.key, owner])

  if (!owner) return null

  async function change(patch: Parameters<typeof updateLanding>[1]) {
    setError(null)
    setSaved(false)
    try {
      await updateLanding(server.key, patch)
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    }
  }

  async function saveDescription() {
    if (draft === null) return
    if (await change({ description: draft })) {
      setDraft(null)
      setSaved(true)
    }
  }

  function inviteLabel(invite: Invite): string {
    const expiry = invite.expiresAt === null ? t('landing.neverExpires') : t('landing.expires', { date: new Date(invite.expiresAt).toLocaleDateString() })
    const uses = invite.maxUses === null ? t('landing.usesOpen', { count: invite.uses }) : t('landing.usesOf', { count: invite.uses, max: invite.maxUses })
    return `…${invite.code.slice(-6)} · ${expiry} · ${uses}${invite.approve ? ` · ${t('landing.approve')}` : ''}`
  }

  const description = draft ?? settings?.description ?? ''
  const choices = landingInviteChoices(invites, Date.now())
  const chosen = settings?.invite ?? null
  const options = chosen && !choices.some((i) => i.code === chosen.code) ? [chosen, ...choices] : choices
  const url = landingUrl(server)

  return (
    <div className="landing-settings" data-testid="landing-section">
      <h3>{t('landing.title')}</h3>
      <p className="muted">{t('landing.intro')}</p>
      {!settings ? (
        error ? <p className="error-text" role="alert">{error}</p> : <Spinner />
      ) : (
        <>
          <div className="landing-switch-row">
            <div>
              <strong>{t('landing.enabled')}</strong>
              <p className="muted">{settings.enabled ? t('landing.enabledOn') : t('landing.enabledOff')}</p>
            </div>
            <button className={`switch ${settings.enabled ? 'on' : ''}`} role="switch" aria-checked={settings.enabled}
              aria-label={t('landing.enabled')} data-testid="landing-enabled"
              onClick={() => void change({ enabled: !settings.enabled })}>
              <span />
            </button>
          </div>

          {settings.enabled && (
            <div className="landing-fields">
              <label className="field">
                <span>{t('landing.description')}</span>
                <textarea value={description} rows={3} maxLength={LANDING_DESCRIPTION_MAX} placeholder={t('landing.descriptionPlaceholder')}
                  data-testid="landing-description" onChange={(e) => { setDraft(e.target.value); setSaved(false) }} />
              </label>
              <div className="landing-description-row">
                <small className="muted">{t('landing.descriptionHint', { length: description.length, max: LANDING_DESCRIPTION_MAX })}</small>
                <button className="button small" disabled={draft === null || draft === settings.description} data-testid="landing-save"
                  onClick={() => void saveDescription()}>
                  {t('common.save')}
                </button>
              </div>
              {saved && <p className="success-text" role="status">{t('landing.saved')}</p>}

              <label className="field">
                <span>{t('landing.invite')}</span>
                <select value={chosen?.code ?? ''} data-testid="landing-invite" onChange={(e) => void change({ invite: e.target.value })}>
                  <option value="">{t('landing.noInvite')}</option>
                  {options.map((i) => <option key={i.code} value={i.code}>{inviteLabel(i)}</option>)}
                </select>
              </label>
              <p className="muted">{choices.length === 0 && !chosen ? t('landing.inviteNone') : t('landing.inviteHint')}</p>
              {settings.inviteGone && <p className="warning-text" role="note" data-testid="landing-invite-gone">{t('landing.inviteGone')}</p>}
              {chosen && paused && <p className="warning-text" role="note">{t('landing.invitesPaused')}</p>}

              <label className="checkbox">
                <input type="checkbox" checked={settings.showRules} data-testid="landing-rules" onChange={(e) => void change({ showRules: e.target.checked })} />
                <span>{t('landing.showRules')}</span>
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={settings.showCounts} data-testid="landing-counts" onChange={(e) => void change({ showCounts: e.target.checked })} />
                <span>{t('landing.showCounts')}<br /><small className="muted">{t('landing.showCountsHint')}</small></span>
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={settings.indexable} data-testid="landing-indexable" onChange={(e) => void change({ indexable: e.target.checked })} />
                <span>{t('landing.indexable')}<br /><small className="muted">{t('landing.indexableHint')}</small></span>
              </label>
            </div>
          )}
          <p className="landing-open">
            <a href={url} target="_blank" rel="noreferrer noopener" data-testid="landing-open">{t('landing.open')}</a>
            <span className="muted"> {url}</span>
          </p>
          {error && <p className="error-text" role="alert">{error}</p>}
        </>
      )}
    </div>
  )
}
