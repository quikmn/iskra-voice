// Voice channel status: the line under a voice channel in the sidebar, the bar in the call where people in it set or
// clear it, and the channel menu item moderators use to clear one from outside the call.
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { useServerBaseRoles } from '../../state/baseRoles'
import { useServerRoles } from '../../state/roles'
import type { ServerState } from '../../state/store'
import { useVoice } from '../../state/voice'
import { setVoiceStatus, useChannelStatus } from '../../state/voiceStatus'
import { VOICE_STATUS_MAX, checkStatusText, mayClearAsModerator, maySetStatus, statusLength } from '../../state/voiceStatusLogic'
import { Pencil } from '../icons'
import { MenuItem } from '../organize/OrgMenu'
import type { Run } from '../organize/Menus'
import './voiceStatus.css'

/** Under a voice channel's name in the sidebar. */
export function VoiceStatusLine({ server, channelId }: { server: ServerState; channelId: number }) {
  const { t } = useTranslation()
  const status = useChannelStatus(server.key, channelId)
  if (!status) return null
  const by = server.members[status.setBy]?.name ?? t('common.someone')
  return (
    <p className="vstatus-line" title={t('voiceStatus.setBy', { name: by })} data-testid="voice-status-line">
      {status.text}
    </p>
  )
}

/** In the call, under its header: the status, and setting or clearing it for those who may. */
export function VoiceStatusBar({ server, channel }: { server: ServerState; channel: Channel }) {
  const { t } = useTranslation()
  const status = useChannelStatus(server.key, channel.id)
  const roles = useServerRoles(server.key)
  const inCall = useVoice((s) => s.session?.serverKey === server.key && s.session.channelId === channel.id && s.session.state === 'connected')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (channel.kind !== 'voice') return null
  const canSet = maySetStatus(server.me, channel, roles, inCall)
  if (!status && !canSet) return null

  const check = checkStatusText(draft)
  const save = async (text: string) => {
    setBusy(true)
    setError(null)
    try {
      await setVoiceStatus(server.key, channel.id, text)
      setEditing(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (check.ok) void save(check.text ?? '')
  }

  if (editing) {
    return (
      <form className="vstatus-bar editing" onSubmit={submit} data-testid="voice-status-editor">
        <label className="vstatus-field">
          <span className="sr-only">{t('voiceStatus.label')}</span>
          <input
            autoFocus
            value={draft}
            maxLength={240}
            placeholder={t('voiceStatus.placeholder')}
            aria-label={t('voiceStatus.label')}
            aria-invalid={!check.ok}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <span className={`vstatus-count ${check.ok ? '' : 'over'}`} aria-hidden>{statusLength(draft.trim())}/{VOICE_STATUS_MAX}</span>
        </label>
        <div className="vstatus-actions">
          <button className="button small primary" type="submit" disabled={busy || !check.ok}>{t('voiceStatus.save')}</button>
          {status && <button className="button small" type="button" disabled={busy} onClick={() => void save('')}>{t('voiceStatus.clear')}</button>}
          <button className="button small" type="button" onClick={() => setEditing(false)}>{t('common.cancel')}</button>
        </div>
        {!check.ok && <p className="error-text" role="alert">{t(check.reason === 'tooLong' ? 'voiceStatus.tooLong' : 'voiceStatus.invalid', { max: VOICE_STATUS_MAX })}</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <p className="muted vstatus-hint">{channel.e2ee ? t('voiceStatus.encrypted') : t('voiceStatus.hint')}</p>
      </form>
    )
  }

  const by = status ? server.members[status.setBy]?.name ?? t('common.someone') : null
  return (
    <div className="vstatus-bar" data-testid="voice-status-bar">
      {status
        ? <span className="vstatus-text" title={t('voiceStatus.setBy', { name: by })}>{status.text}</span>
        : <span className="vstatus-text muted">{t('voiceStatus.none')}</span>}
      {canSet && (
        <button
          className="icon-button small"
          type="button"
          aria-label={status ? t('voiceStatus.edit') : t('voiceStatus.set')}
          title={status ? t('voiceStatus.edit') : t('voiceStatus.set')}
          onClick={() => {
            setDraft(status?.text ?? '')
            setError(null)
            setEditing(true)
          }}
        >
          <Pencil size={16} />
        </button>
      )}
    </div>
  )
}

/** Channel menu: voice moderators clear a status from outside the call (the server audits it). */
export function ClearVoiceStatusItem({ server, channel, run }: { server: ServerState; channel: Channel; run: Run }) {
  const { t } = useTranslation()
  const status = useChannelStatus(server.key, channel.id)
  const roles = useServerRoles(server.key)
  const baseRoles = useServerBaseRoles(server.key)
  if (!status || channel.kind !== 'voice' || !mayClearAsModerator(server.me, roles, baseRoles)) return null
  return (
    <MenuItem
      hint={status.text}
      onClick={run(() => setVoiceStatus(server.key, channel.id, ''))}
    >
      {t('voiceStatus.clearMenu')}
    </MenuItem>
  )
}
