// The invites that still work: admins see everyone's, others their own. Each can be revoked.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Secret } from '../streamer/StreamerBits'
import type { Invite } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { formatDate } from '../../i18n/format'
import { sortInvites } from '../../state/inviteRules'
import { levelName } from '../../state/permissions'
import { connectionFor, type ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './InviteDialog.css'
import '../invitetrack.css'

/** `refresh` changes whenever the dialog made a new invite; `onRevoked` lets it drop a link it shows. */
export function InviteList({ server, current, refresh, onRevoked }: {
  server: ServerState
  current: string | null
  refresh: unknown
  onRevoked: (code: string) => void
}) {
  const { t } = useTranslation()
  const [invites, setInvites] = useState<Invite[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(() => {
    connectionFor(server.key)?.request('invite.list', {})
      .then((r) => setInvites(sortInvites(r.invites)))
      .catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])
  useEffect(reload, [reload, refresh])

  async function revoke(code: string) {
    setBusy(code)
    try {
      await connectionFor(server.key)?.request('invite.revoke', { code })
      setInvites((all) => all?.filter((i) => i.code !== code) ?? null)
      setError(null)
      onRevoked(code)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const nameOf = (key: string) => server.members[key]?.name ?? t('settings.invite.someone')

  return (
    <section className="invite-list" aria-labelledby="invite-list-title">
      <h3 id="invite-list-title">{t('settings.invite.active')}</h3>
      {invites === null ? <Spinner /> : invites.length === 0 ? (
        <p className="muted">{t('settings.invite.noneActive')}</p>
      ) : (
        <ul>
          {invites.map((invite) => (
            <li key={invite.code} className="invite-row" data-testid="invite-row" data-never={invite.expiresAt === null || undefined}>
              <div className="invite-main">
                <span className="invite-code"><Secret value={invite.code.slice(-6)} title={invite.code} prefix="…" /></span>
                {invite.label && <span className="invite-label" data-testid="invite-label">{invite.label}</span>}
                {invite.code === current && <span className="invite-this">{t('settings.invite.thisLink')}</span>}
                {invite.approve && <span className="pill invite-approval">{t('settings.invite.approval')}</span>}
                <span className="invite-meta">
                  {levelName(invite.role)}
                  {' · '}
                  {invite.maxUses
                    ? t('settings.invite.usesOf', { count: invite.maxUses, uses: invite.uses })
                    : t('settings.invite.uses', { count: invite.uses })}
                  {invite.createdBy !== server.me?.accountKey && ` · ${t('settings.invite.by', { name: nameOf(invite.createdBy) })}`}
                </span>
              </div>
              {invite.expiresAt === null ? (
                <span className="pill invite-never">{t('settings.invite.neverExpires')}</span>
              ) : (
                <span className="invite-expires">
                  {t('settings.invite.expiresOn', { when: formatDate(invite.expiresAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })}
                </span>
              )}
              <button
                className="button danger-outline small"
                disabled={busy === invite.code}
                aria-label={t('settings.invite.revokeLabel', { code: invite.code.slice(-6) })}
                onClick={() => void revoke(invite.code)}
              >
                {busy === invite.code ? <Spinner /> : t('settings.invite.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  )
}
