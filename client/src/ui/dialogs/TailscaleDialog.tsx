// "Use Tailscale (free)": the recommended "gaming VPN" when the host is behind CGNAT. Why it's needed, what Tailscale
// sees, and the steps for the host and each friend; plus the invite for Tailscale once it's on where the server runs.
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { ServerState } from '../../state/store'
import { Modal } from '../bits'
import { InviteDialog } from './InviteDialog'
import { OwnershipNote } from './ReachabilityHelp'
import './RentServerDialog.css'

// A plain link, no tracking parameters.
const DOWNLOAD = 'https://tailscale.com/download'
const download = <a href={DOWNLOAD} target="_blank" rel="noopener noreferrer" />

export function TailscaleDialog({ server, tailscaleUrl, onClose }: { server?: ServerState; tailscaleUrl: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  const [inviting, setInviting] = useState(false)
  if (inviting && server) return <InviteDialog server={server} via="tailscale" onClose={onClose} />

  return (
    <Modal title={t('hosting.tailscale.title')} onClose={onClose} wide className="rent-server tailscale-guide">
      <OwnershipNote />
      <p>{t('hosting.tailscale.why')}</p>
      {/*
        Terms as of 2026-10-12 (tailscale.com/pricing, tailscale.com/kb/1084/sharing): the Personal plan is free for
        non-commercial use with 6 users and unlimited devices; sharing a machine works on every plan and the people it's
        shared with use their own free accounts. Terms change: check them again before changing this text.
      */}
      <ul className="tailscale-facts">
        <li>{t('hosting.tailscale.free')}</li>
        <li>{t('hosting.tailscale.sees')}</li>
      </ul>

      {tailscaleUrl ? (
        <div className="internet-callout" data-testid="tailscale-found">
          <p><Trans i18nKey="hosting.tailscale.found" values={{ url: tailscaleUrl }} components={{ code: <code /> }} /></p>
          {server && <button className="button primary" onClick={() => setInviting(true)}>{t('hosting.tailscale.invite')}</button>}
        </div>
      ) : (
        <p className="muted" data-testid="tailscale-not-found">{t('hosting.tailscale.notFound')}</p>
      )}

      <h4>{t('hosting.tailscale.hostTitle')}</h4>
      <ol className="rent-steps">
        <li><Trans i18nKey="hosting.tailscale.host1" components={{ download }} /></li>
        <li>{t('hosting.tailscale.host2')}</li>
        <li><Trans i18nKey="hosting.tailscale.host3" components={{ b: <strong /> }} /></li>
        <li><Trans i18nKey="hosting.tailscale.host4" components={{ b: <strong /> }} /></li>
      </ol>
      <h4>{t('hosting.tailscale.friendsTitle')}</h4>
      <ol className="rent-steps">
        <li><Trans i18nKey="hosting.tailscale.friend1" components={{ download }} /></li>
        <li><Trans i18nKey="hosting.tailscale.friend2" components={{ b: <strong /> }} /></li>
        <li>{t('hosting.tailscale.friend3')}</li>
      </ol>
      <p className="muted small">{t('hosting.tailscale.trouble')}</p>
    </Modal>
  )
}
