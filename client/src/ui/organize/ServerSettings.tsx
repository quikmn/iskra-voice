// "This server" pieces for settings: your notification level and mute here, nicknames, and the per-server picture.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { roleRank, type Member, type NotifyDefault, type NotifyLevel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { muteFor, setNickname, setNotifyLevel, setServerAvatar, setServerNotifyDefault, useNotifyFor, useOrganize, useServerNotifyDefault } from '../../state/organize'
import { useServerBaseRoles } from '../../state/baseRoles'
import { baseAllows } from '../../state/permissions'
import { levelLabel, MUTE_CHOICES, muteChoiceLabel, muteLabel, SMALL_SERVER } from '../../state/organizeLogic'
import { Avatar } from '../bits'
import { AvatarCropper } from '../profile/AvatarCropper'
import './organize.css'

/** Level and mute for a whole server. Channels can override the level from their own menu. */
export function ServerNotifySettings({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const notify = useNotifyFor(server.key, null)
  const own = useOrganize((s) => s.notify[server.key]?.server)
  const [error, setError] = useState<string | null>(null)
  const clock = useOrganize((s) => s.clock)
  const muted = muteLabel(own?.mutedUntil ?? null, clock)
  const serverDefault = useServerNotifyDefault(server.key)
  const baseRoles = useServerBaseRoles(server.key)
  const canSetDefault = baseAllows(baseRoles, server.me, 'organize')
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(errorMessage(e)))
  }
  return (
    <div className="org-notify" role="group" aria-label={t('organize.notify.groupLabel', { server: server.name })}>
      <h3 className="h4">{t('organize.notify.heading', { server: server.name })}</h3>
      <div className="segmented" role="radiogroup" aria-label={t('organize.notify.label')}>
        {(['all', 'mentions', 'none'] as NotifyLevel[]).map((level) => (
          <button key={level} role="radio" aria-checked={notify.chosen === level} className={notify.chosen === level ? 'on' : ''}
            onClick={() => run(() => setNotifyLevel(server.key, null, level))}>
            {levelLabel(level)}
          </button>
        ))}
      </div>
      {!own?.level && (
        <p className="muted org-notify-default">
          {serverDefault === 'auto'
            ? t(notify.chosen === 'all' ? 'organize.notify.defaultSmall' : 'organize.notify.defaultBig', { server: server.name, max: SMALL_SERVER })
            : t(serverDefault === 'all' ? 'organize.notify.defaultChosenAll' : 'organize.notify.defaultChosenMentions', { server: server.name })}
        </p>
      )}
      <div className="org-notify-row">
        {muted ? (
          <>
            <span className="muted">{muted}</span>
            <button className="button" onClick={() => run(() => muteFor(server.key, null, 0))}>{t('organize.notify.unmuteServer')}</button>
          </>
        ) : (
          <label className="field inline">
            <span>{t('organize.notify.muteServer')}</span>
            <select value="" aria-label={t('organize.notify.muteServer')} onChange={(e) => e.target.value && run(() => muteFor(server.key, null, Number(e.target.value)))}>
              <option value="">{t('organize.notify.notMuted')}</option>
              {MUTE_CHOICES.map((c) => <option key={c.minutes} value={c.minutes}>{muteChoiceLabel(c)}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="muted">{t('organize.notify.hint')}</p>
      {canSetDefault && (
        <label className="field inline org-notify-server-default">
          <span>{t('organize.notify.serverDefault')}</span>
          <select value={serverDefault} aria-label={t('organize.notify.serverDefault')}
            onChange={(e) => run(() => setServerNotifyDefault(server.key, e.target.value as NotifyDefault))}>
            <option value="auto">{t('organize.notify.serverDefaultAuto', { max: SMALL_SERVER })}</option>
            <option value="all">{levelLabel('all')}</option>
            <option value="mentions">{levelLabel('mentions')}</option>
          </select>
        </label>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

/** Your own, or (admins) the nickname of someone ranked below you: the server checks the same. */
export function canEditNickname(me: Member | null | undefined, member: Member): boolean {
  return !!me && (me.accountKey === member.accountKey || (roleRank(me.role) >= roleRank('admin') && roleRank(me.role) > roleRank(member.role)))
}

/** Your server nickname, or (admins, for members ranked below them) someone else's. Empty means their name. */
export function NicknameField({ server, member: given, onDone }: { server: ServerState; member: Member; onDone?: () => void }) {
  const { t } = useTranslation()
  const member = server.members[given.accountKey] ?? given // the latest copy
  const me = server.me
  const isSelf = me?.accountKey === member.accountKey
  const canEdit = canEditNickname(me, member)
  const [value, setValue] = useState(member.nick ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  if (!canEdit) return null
  const trimmed = value.trim()
  const changed = trimmed !== (member.nick ?? '')

  async function save(nick: string) {
    setError(null)
    setSaved(false)
    try {
      await setNickname(server.key, nick, isSelf ? undefined : member.accountKey)
      setValue(nick)
      setSaved(true)
      onDone?.()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="org-nick">
      <div className="org-nick-row">
        <label className="field">
          <span>{t('organize.nick.label')}</span>
          <input value={value} maxLength={32} placeholder={member.profileName ?? member.name}
            onChange={(e) => { setValue(e.target.value); setSaved(false) }}
            onKeyDown={(e) => e.key === 'Enter' && changed && void save(trimmed)} />
        </label>
        <button className="button primary" disabled={!changed} onClick={() => void save(trimmed)}>{t('common.save')}</button>
        {member.nick && <button className="button" onClick={() => void save('')}>{t(isSelf ? 'organize.nick.useMine' : 'organize.nick.useTheirs')}</button>}
      </div>
      <p className="muted">
        {saved ? t('organize.nick.saved') : t(isSelf ? 'organize.nick.hintYours' : 'organize.nick.hintTheirs', { server: server.name, name: member.profileName ?? member.name })}
      </p>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

/**
 * The per-server picture, next to the nickname: yours, or (admins, for members ranked below them) someone else's.
 * Cropped on this device like the profile picture; the server strips what metadata is left. The preview is what
 * `member.avatar` says right now (this server's picture, else the profile's).
 */
export function ServerAvatarField({ server, member: given }: { server: ServerState; member: Member }) {
  const { t } = useTranslation()
  const member = server.members[given.accountKey] ?? given
  const me = server.me
  const isSelf = me?.accountKey === member.accountKey
  const [cropping, setCropping] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  if (!canEditNickname(me, member)) return null

  async function apply(image: Blob | null) {
    setCropping(null)
    setBusy(true)
    try {
      await setServerAvatar(server.key, image, isSelf ? undefined : member.accountKey)
      setStatus({ kind: 'saved', text: image ? t('organize.avatar.updated') : t('organize.avatar.removed') })
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="org-avatar" data-testid="server-avatar">
      <span className="field-label">{t('organize.avatar.label')}</span>
      <div className="org-avatar-row">
        <Avatar name={member.name} accountKey={member.accountKey} size={56} />
        <div className="copy-row">
          <button className="button small" disabled={busy} onClick={() => input.current?.click()}>
            {member.serverAvatar ? t('organize.avatar.change') : t('organize.avatar.upload')}
          </button>
          {member.serverAvatar && <button className="button small danger-outline" disabled={busy} onClick={() => void apply(null)}>{t('common.remove')}</button>}
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label={t('organize.avatar.label')} data-testid="server-avatar-file"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) setCropping(file)
            }} />
        </div>
      </div>
      <p className={status?.kind === 'error' ? 'error-text' : 'muted'} role={status ? 'status' : undefined}>
        {status ? status.text : t(isSelf ? 'organize.avatar.hintYours' : 'organize.avatar.hintTheirs', { server: server.name })}
      </p>
      {cropping && <AvatarCropper file={cropping} title={t('organize.avatar.crop')} confirm={t('settings.overview.use')} onCancel={() => setCropping(null)} onDone={(image) => void apply(image)} />}
    </div>
  )
}
