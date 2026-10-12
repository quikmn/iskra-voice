// Settings → Profile: picture, name, pronouns, bio, accent colour and your profile page.
// Saved on this device and sent to every server you're on.
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { b64u } from '../../core/crypto'
import { fingerprint } from '../../core/connection'
import { MAX_BIO, MAX_PRONOUNS } from '../../core/profile'
import { roleRank } from '../../core/protocol'
import { setAvatar, setPagesEnabled, updateProfile, useProfiles } from '../../state/profile'
import { useApp, type ServerState } from '../../state/store'
import { Avatar } from '../bits'
import { AvatarCropper } from './AvatarCropper'
import { PageEditor } from './PageEditor'
import './profile.css'

export function ProfileSection() {
  const { t } = useTranslation()
  const profile = useApp((s) => s.profile)
  const identity = useApp((s) => s.identity)
  // Servers where a server nickname is shown instead of your name.
  const nicknamed = useApp((s) => s.order.map((k) => s.servers[k]).filter((v) => v?.me?.nick).map((v) => v!.name).join(', '))
  const [name, setName] = useState(profile?.name ?? '')
  const [pronouns, setPronouns] = useState(profile?.pronouns ?? '')
  const [bio, setBio] = useState(profile?.bio ?? '')
  const [accent, setAccent] = useState(profile?.accent ?? '')
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)
  const [cropping, setCropping] = useState<File | null>(null)
  const [editingPage, setEditingPage] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const accountKey = identity ? b64u(identity.account.publicKey) : ''

  const avatarUrl = useObjectUrl(profile?.avatar)

  const trimmed = name.trim()
  const changes = {
    ...(trimmed && trimmed !== profile?.name ? { name: trimmed } : {}),
    ...(pronouns.trim() !== (profile?.pronouns ?? '') ? { pronouns: pronouns.trim() } : {}),
    ...(bio.trim() !== (profile?.bio ?? '') ? { bio: bio.trim() } : {}),
    ...(accent !== (profile?.accent ?? '') ? { accent } : {}),
  }
  const dirty = Object.keys(changes).length > 0

  function report(failed: string[], done: string) {
    setStatus(failed.length ? { kind: 'error', text: t('profile.savedExcept', { servers: failed.join(', ') }) } : { kind: 'saved', text: done })
  }

  async function save() {
    if (!dirty || !trimmed) return
    try {
      report(await updateProfile(changes), changes.name ? t('profile.nameSaved') : t('common.saved'))
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    }
  }

  async function applyAvatar(image: Blob | null) {
    setCropping(null)
    try {
      report(await setAvatar(image), image ? t('profile.pictureUpdated') : t('profile.pictureRemoved'))
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e) })
    }
  }

  return (
    <section className="settings-section">
      <h2>{t('settings.sections.profile')}</h2>
      <div className="avatar-row">
        <Avatar name={trimmed || '?'} accountKey={accountKey} size={72} src={avatarUrl} />
        <div className="copy-row">
          <button className="button small" onClick={() => fileInput.current?.click()}>{profile?.avatar ? t('profile.changePicture') : t('profile.uploadPicture')}</button>
          {profile?.avatar && <button className="button small danger-outline" onClick={() => void applyAvatar(null)}>{t('common.remove')}</button>}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            aria-label={t('profile.picture')}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) setCropping(file)
            }}
          />
        </div>
      </div>

      <label className="field">
        <span>{t('profile.name')}</span>
        <input value={name} maxLength={32} aria-describedby="profile-name-hint" onChange={(e) => { setName(e.target.value); setStatus(null) }} />
      </label>
      <p id="profile-name-hint" className="muted field-note">
        {t('profile.nameHint')}{nicknamed && ` ${t('profile.nicknamesHere', { servers: nicknamed })}`}
      </p>
      <label className="field">
        <span>{t('profile.pronouns')}</span>
        <input value={pronouns} maxLength={MAX_PRONOUNS} placeholder={t('profile.optional')} onChange={(e) => { setPronouns(e.target.value); setStatus(null) }} />
      </label>
      <label className="field">
        <span>{t('profile.aboutMe', { length: bio.trim().length, max: MAX_BIO })}</span>
        <textarea
          value={bio}
          rows={3}
          maxLength={MAX_BIO}
          placeholder={t('profile.bioPlaceholder')}
          onChange={(e) => { setBio(e.target.value); setStatus(null) }}
        />
      </label>
      <div className="field">
        <span>{t('profile.accent')}</span>
        <div className="copy-row">
          <input className="color-input" type="color" value={accent || '#7c6fff'} aria-label={t('profile.accent')} onChange={(e) => { setAccent(e.target.value); setStatus(null) }} />
          {accent ? <button className="button small" onClick={() => setAccent('')}>{t('profile.useDefault')}</button> : <span className="muted">{t('profile.accentHint')}</span>}
        </div>
      </div>
      <div className="copy-row">
        <button className="button primary" disabled={!dirty || !trimmed} onClick={() => void save()}>{t('profile.save')}</button>
        {status && <span className={status.kind === 'error' ? 'error-text' : 'success-text'}>{status.text}</span>}
      </div>

      <div className="page-summary">
        <div>
          <strong>{t('profile.page')}</strong>
          <p className="muted">
            {profile?.page ? t('profile.pagePublished') : t('profile.pageHint')}
          </p>
        </div>
        <button className="button small" onClick={() => setEditingPage(true)}>{profile?.page ? t('profile.editPage') : t('profile.makePage')}</button>
      </div>

      {identity && (
        <p className="muted">
          <Trans i18nKey="profile.yourId" values={{ id: fingerprint(accountKey) }} components={{ code: <code /> }} />
        </p>
      )}

      {cropping && <AvatarCropper file={cropping} onCancel={() => setCropping(null)} onDone={(image) => void applyAvatar(image)} />}
      {editingPage && <PageEditor onClose={() => setEditingPage(false)} />}
    </section>
  )
}

/** Admins: whether members may publish profile pages on this server. */
export function ServerPagesOption({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const enabled = useProfiles((s) => !!s.pagesEnabled[server.key])
  const [error, setError] = useState<string | null>(null)
  if (!server.me || roleRank(server.me.role) < roleRank('admin')) return null
  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void setPagesEnabled(server.key, e.target.checked).then(() => setError(null), (err: Error) => setError(errorMessage(err)))}
        />
        {t('profile.allowPages')}
      </label>
      {error && <p className="error-text">{error}</p>}
    </>
  )
}

/** A blob: URL for the stored avatar, revoked when it changes or the component goes away. */
function useObjectUrl(avatar: { bytes: ArrayBuffer; type: string } | null | undefined): string | null {
  const [url, setUrl] = useState<{ for: object; url: string } | null>(null)
  useEffect(() => {
    if (!avatar) return
    const objectUrl = URL.createObjectURL(new Blob([avatar.bytes], { type: avatar.type }))
    const frame = requestAnimationFrame(() => setUrl({ for: avatar, url: objectUrl }))
    return () => {
      cancelAnimationFrame(frame)
      URL.revokeObjectURL(objectUrl)
    }
  }, [avatar])
  return avatar && url?.for === avatar ? url.url : null
}
