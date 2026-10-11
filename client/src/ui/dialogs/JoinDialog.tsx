import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { fingerprint } from '../../core/connection'
import { parseInvite, type InviteLink } from '../../core/invite'
import { acceptInvite, useApp } from '../../state/store'
import { Modal } from '../bits'
import { OpenInApp } from '../OpenInApp'
import { hostOf } from '../format'

/** Paste an invite link. */
export function JoinDialog({ onClose, onCreate }: { onClose: () => void; onCreate?: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const invite = parseInvite(text)
  const showError = text.trim().length > 0 && !invite

  function join() {
    if (!invite) return
    acceptInvite(invite)
    onClose()
  }

  return (
    <Modal
      title={t('settings.join.title')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={!invite} onClick={join}>{t('common.join')}</button>
        </>
      }
    >
      <label className="field">
        <span>{t('settings.join.inviteLink')}</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && join()}
          placeholder="https://app.iskra.foo/#/join/…"
        />
      </label>
      {showError && <p className="error-text">{t('settings.join.invalid')}</p>}
      {invite && <InviteSummary invite={invite} />}
      {onCreate && (
        <p className="muted">
          <Trans i18nKey="settings.join.orCreate" components={{ link: <button className="link" onClick={onCreate} /> }} />
        </p>
      )}
    </Modal>
  )
}

/** Confirmation when someone opens an invite link while already set up. */
export function JoinPrompt({ invite }: { invite: InviteLink }) {
  const { t } = useTranslation()
  const close = () => useApp.setState({ pendingInvite: null })
  return (
    <Modal
      title={t('settings.join.invited')}
      onClose={close}
      footer={
        <>
          <button className="button" onClick={close}>{t('settings.join.notNow')}</button>
          <button className="button primary" onClick={() => acceptInvite(invite)}>{t('settings.join.joinServer')}</button>
        </>
      }
    >
      <InviteSummary invite={invite} />
    </Modal>
  )
}

function InviteSummary({ invite }: { invite: InviteLink }) {
  const { t } = useTranslation()
  return (
    <div className="invite-summary">
      <div>
        <span className="label">{t('settings.join.server')}</span>
        <strong>{hostOf(invite.serverUrl)}</strong>
      </div>
      <div>
        <span className="label">{t('settings.overview.serverId')}</span>
        <code>{fingerprint(invite.serverKey)}</code>
      </div>
      <OpenInApp invite={invite} />
      {invite.serverUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.|192\.168\.|10\.)/.test(invite.serverUrl) && (
        <p className="warning-text">{t('settings.join.noHttps')}</p>
      )}
    </div>
  )
}
