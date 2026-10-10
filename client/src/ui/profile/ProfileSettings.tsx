// Settings → Profile: picture, name, pronouns, bio, accent colour and your profile page.
// Saved on this device and sent to every server you're on.
import { useEffect, useMemo, useRef, useState } from 'react'
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
  const profile = useApp((s) => s.profile)
  const identity = useApp((s) => s.identity)
  const [name, setName] = useState(profile?.name ?? '')
  const [pronouns, setPronouns] = useState(profile?.pronouns ?? '')
  const [bio, setBio] = useState(profile?.bio ?? '')
  const [accent, setAccent] = useState(profile?.accent ?? '')
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)
  const [cropping, setCropping] = useState<File | null>(null)
  const [editingPage, setEditingPage] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const accountKey = identity ? b64u(identity.account.publicKey) : ''

  const avatarUrl = useMemo(
    () => (profile?.avatar ? URL.createObjectURL(new Blob([profile.avatar.bytes], { type: profile.avatar.type })) : null),
    [profile?.avatar],
  )
  useEffect(() => () => { if (avatarUrl) URL.revokeObjectURL(avatarUrl) }, [avatarUrl])

  const trimmed = name.trim()
  const changes = {
    ...(trimmed && trimmed !== profile?.name ? { name: trimmed } : {}),
    ...(pronouns.trim() !== (profile?.pronouns ?? '') ? { pronouns: pronouns.trim() } : {}),
    ...(bio.trim() !== (profile?.bio ?? '') ? { bio: bio.trim() } : {}),
    ...(accent !== (profile?.accent ?? '') ? { accent } : {}),
  }
  const dirty = Object.keys(changes).length > 0

  function report(failed: string[], done: string) {
    setStatus(failed.length ? { kind: 'error', text: `Saved here, but ${failed.join(', ')} didn't take it.` } : { kind: 'saved', text: done })
  }

  async function save() {
    if (!dirty || !trimmed) return
    try {
      report(await updateProfile(changes), 'Saved')
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    }
  }

  async function applyAvatar(image: Blob | null) {
    setCropping(null)
    try {
      report(await setAvatar(image), image ? 'Picture updated' : 'Picture removed')
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message })
    }
  }

  return (
    <section className="settings-section">
      <h3>Profile</h3>
      <div className="avatar-row">
        <Avatar name={trimmed || '?'} accountKey={accountKey} size={72} src={avatarUrl} />
        <div className="copy-row">
          <button className="button small" onClick={() => fileInput.current?.click()}>{profile?.avatar ? 'Change picture' : 'Upload picture'}</button>
          {profile?.avatar && <button className="button small danger-outline" onClick={() => void applyAvatar(null)}>Remove</button>}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            aria-label="Profile picture"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) setCropping(file)
            }}
          />
        </div>
      </div>

      <label className="field">
        <span>Display name</span>
        <input value={name} maxLength={32} onChange={(e) => { setName(e.target.value); setStatus(null) }} />
      </label>
      <label className="field">
        <span>Pronouns</span>
        <input value={pronouns} maxLength={MAX_PRONOUNS} placeholder="Optional" onChange={(e) => { setPronouns(e.target.value); setStatus(null) }} />
      </label>
      <label className="field">
        <span>About me · {bio.trim().length}/{MAX_BIO}</span>
        <textarea
          value={bio}
          rows={3}
          maxLength={MAX_BIO}
          placeholder="A line or two. **bold**, *italic* and links work."
          onChange={(e) => { setBio(e.target.value); setStatus(null) }}
        />
      </label>
      <div className="field">
        <span>Accent colour</span>
        <div className="copy-row">
          <input className="color-input" type="color" value={accent || '#7c6fff'} aria-label="Accent colour" onChange={(e) => { setAccent(e.target.value); setStatus(null) }} />
          {accent ? <button className="button small" onClick={() => setAccent('')}>Use default</button> : <span className="muted">Shown on your profile card</span>}
        </div>
      </div>
      <div className="copy-row">
        <button className="button primary" disabled={!dirty || !trimmed} onClick={() => void save()}>Save profile</button>
        {status && <span className={status.kind === 'error' ? 'error-text' : 'success-text'}>{status.text}</span>}
      </div>

      <div className="page-summary">
        <div>
          <strong>Profile page</strong>
          <p className="muted">
            {profile?.page ? 'Published on servers that allow pages.' : 'Your own little web page, shown from your profile card.'}
          </p>
        </div>
        <button className="button small" onClick={() => setEditingPage(true)}>{profile?.page ? 'Edit page' : 'Make a page'}</button>
      </div>

      {identity && (
        <p className="muted">
          Your ID: <code>{fingerprint(accountKey)}</code>. Friends can use it to check it's really you.
        </p>
      )}

      {cropping && <AvatarCropper file={cropping} onCancel={() => setCropping(null)} onDone={(image) => void applyAvatar(image)} />}
      {editingPage && <PageEditor onClose={() => setEditingPage(false)} />}
    </section>
  )
}

/** Admins: whether members may publish profile pages on this server. */
export function ServerPagesOption({ server }: { server: ServerState }) {
  const enabled = useProfiles((s) => !!s.pagesEnabled[server.key])
  const [error, setError] = useState<string | null>(null)
  if (!server.me || roleRank(server.me.role) < roleRank('admin')) return null
  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void setPagesEnabled(server.key, e.target.checked).then(() => setError(null), (err: Error) => setError(err.message))}
        />
        Members can publish profile pages here
      </label>
      {error && <p className="error-text">{error}</p>}
    </>
  )
}
