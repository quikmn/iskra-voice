// Settings: your soundboard volume, and managing this server's emoji and sounds.
import { useRef, useState } from 'react'
import { roleRank, type CustomEmoji, type Sound } from '../../core/protocol'
import {
  addEmoji, addSound, deleteEmoji, deleteSound, emojiNameFrom, playUrl, renameEmoji, serverFileUrl, updateSound,
  updateSoundboardSettings, useExpressions, useServerEmojis, useServerSounds,
} from '../../state/expressions'
import type { ServerState } from '../../state/store'
import { Trash } from '../icons'
import { Play } from './icons'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { formatNumber } from '../../i18n/format'

const MAX_EMOJIS = 200

export function SoundboardSettingsSection() {
  const { t } = useTranslation()
  const { volume, muted } = useExpressions((s) => s.settings)
  return (
    <section className="settings-section">
      <h3>{t('expressions.settings.soundboard')}</h3>
      <label className="field">
        <span>{t('expressions.settings.volume', { percent: Math.round(volume * 100) })}</span>
        <input
          type="range" min={0} max={100} step={5} value={Math.round(volume * 100)} disabled={muted}
          aria-label={t('expressions.settings.volumeLabel')}
          onChange={(e) => updateSoundboardSettings({ volume: Number(e.target.value) / 100 })}
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={muted} onChange={(e) => updateSoundboardSettings({ muted: e.target.checked })} />
        {t('expressions.settings.mute')}
      </label>
    </section>
  )
}

/** Server emoji and sounds, for the people allowed to manage them. Others see nothing here. */
export function ServerExpressionsSections({ server }: { server: ServerState }) {
  const rank = server.me ? roleRank(server.me.role) : -1
  return (
    <>
      {rank >= roleRank('admin') && <EmojiSection server={server} />}
      {rank >= roleRank('trusted') && <SoundsSection server={server} />}
    </>
  )
}

export function EmojiSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const emojis = useServerEmojis(server.key)
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ file: File; preview: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameValid = !!pending && /^[a-z0-9_]{2,32}$/.test(pending.name)

  function choose(file: File | undefined) {
    if (!file) return
    if (pending) URL.revokeObjectURL(pending.preview)
    setError(null)
    setPending({ file, preview: URL.createObjectURL(file), name: emojiNameFrom(file.name) })
  }

  async function upload() {
    if (!pending || !nameValid) return
    setBusy(true)
    setError(null)
    try {
      await addEmoji(server.key, pending.file, pending.name)
      URL.revokeObjectURL(pending.preview)
      setPending(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h3>{t('expressions.settings.emojiTitle', { count: emojis.length, max: MAX_EMOJIS })}</h3>
      <p className="muted"><Trans i18nKey="expressions.settings.emojiIntro" components={{ code: <code /> }} /></p>
      <input ref={input} type="file" hidden accept="image/png,image/gif,image/webp,image/jpeg" aria-label={t('expressions.settings.emojiImage')} onChange={(e) => { choose(e.target.files?.[0]); e.target.value = '' }} />
      {pending ? (
        <div className="expression-new">
          <img className="custom-emoji big" src={pending.preview} alt="" />
          <input
            value={pending.name} maxLength={32} aria-label={t('expressions.settings.emojiName')}
            onChange={(e) => setPending({ ...pending, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
            onKeyDown={(e) => e.key === 'Enter' && void upload()}
          />
          <button className="button primary" disabled={busy || !nameValid} onClick={() => void upload()}>{busy ? t('expressions.settings.adding') : t('common.add')}</button>
          <button className="button" disabled={busy} onClick={() => { URL.revokeObjectURL(pending.preview); setPending(null) }}>{t('common.cancel')}</button>
        </div>
      ) : (
        <button className="button" disabled={emojis.length >= MAX_EMOJIS} onClick={() => input.current?.click()}>{t('expressions.settings.uploadEmoji')}</button>
      )}
      {error && <p className="error-text">{error}</p>}
      {emojis.length > 0 && (
        <ul className="expression-list">
          {emojis.map((emoji) => <EmojiRow key={emoji.id} server={server} emoji={emoji} />)}
        </ul>
      )}
    </section>
  )
}

function EmojiRow({ server, emoji }: { server: ServerState; emoji: CustomEmoji }) {
  const { t } = useTranslation()
  const [name, setName] = useState(emoji.name)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  async function rename() {
    if (name === emoji.name) return
    try {
      await renameEmoji(server.key, emoji.id, name)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
      setName(emoji.name)
    }
  }

  return (
    <li className="expression-row">
      <img className="custom-emoji big" src={serverFileUrl(server.key, emoji.url) ?? undefined} alt={`:${emoji.name}:`} />
      <div className="expression-fields">
        <input
          value={name} maxLength={32} aria-label={t('expressions.settings.nameOf', { name: `:${emoji.name}:` })}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          onBlur={() => void rename()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="muted">{t('expressions.settings.by', { name: server.members[emoji.createdBy]?.name ?? t('expressions.settings.formerMember') })}</span>
        {error && <span className="error-text">{error}</span>}
      </div>
      {confirm ? (
        <>
          <button className="button danger small" onClick={() => void deleteEmoji(server.key, emoji.id).catch((e: Error) => setError(errorMessage(e)))}>{t('common.delete')}</button>
          <button className="button small" onClick={() => setConfirm(false)}>{t('expressions.settings.keep')}</button>
        </>
      ) : (
        <button className="icon-button" aria-label={t('expressions.settings.deleteName', { name: `:${emoji.name}:` })} title={t('common.delete')} onClick={() => setConfirm(true)}><Trash size={16} /></button>
      )}
    </li>
  )
}

export function SoundsSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const sounds = useServerSounds(server.key)
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ file: File; name: string; emoji: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload() {
    if (!pending || !pending.name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await addSound(server.key, pending.file, pending.name.trim(), pending.emoji.trim() || null)
      setPending(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h3>{t('expressions.settings.soundsTitle', { count: sounds.length })}</h3>
      <p className="muted">{t('expressions.settings.soundsIntro')}</p>
      <input ref={input} type="file" hidden accept="audio/mpeg,audio/ogg,audio/wav,audio/x-wav,.mp3,.ogg,.wav" aria-label={t('expressions.settings.soundFile')}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) setPending({ file, name: file.name.replace(/\.\w+$/, '').slice(0, 32), emoji: '' })
        }} />
      {pending ? (
        <div className="expression-new">
          <input className="sound-emoji-input" value={pending.emoji} maxLength={16} placeholder="🔊" aria-label={t('expressions.settings.soundEmoji')} onChange={(e) => setPending({ ...pending, emoji: e.target.value })} />
          <input value={pending.name} maxLength={32} aria-label={t('expressions.settings.soundName')} onChange={(e) => setPending({ ...pending, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void upload()} />
          <button className="button primary" disabled={busy || !pending.name.trim()} onClick={() => void upload()}>{busy ? t('expressions.settings.adding') : t('common.add')}</button>
          <button className="button" disabled={busy} onClick={() => setPending(null)}>{t('common.cancel')}</button>
        </div>
      ) : (
        <button className="button" onClick={() => input.current?.click()}>{t('expressions.settings.uploadSound')}</button>
      )}
      {error && <p className="error-text">{error}</p>}
      {sounds.length > 0 && (
        <ul className="expression-list">
          {sounds.map((sound) => <SoundRow key={sound.id} server={server} sound={sound} />)}
        </ul>
      )}
    </section>
  )
}

function SoundRow({ server, sound }: { server: ServerState; sound: Sound }) {
  const { t } = useTranslation()
  const me = server.me
  const canManage = !!me && (sound.createdBy === me.accountKey || roleRank(me.role) >= roleRank('admin'))
  const [name, setName] = useState(sound.name)
  const [emoji, setEmoji] = useState(sound.emoji ?? '')
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const url = serverFileUrl(server.key, sound.url)

  async function save() {
    if (name.trim() === sound.name && (emoji.trim() || null) === sound.emoji) return
    try {
      await updateSound(server.key, sound.id, name.trim(), emoji.trim() || null)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
      setName(sound.name)
      setEmoji(sound.emoji ?? '')
    }
  }

  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur()

  return (
    <li className="expression-row">
      <button className="icon-button" aria-label={t('expressions.settings.preview', { name: sound.name })} title={t('expressions.settings.previewTitle')} disabled={!url} onClick={() => url && playUrl(url)}>
        <Play size={16} />
      </button>
      {canManage ? (
        <>
          <input className="sound-emoji-input" value={emoji} maxLength={16} placeholder="🔊" aria-label={t('expressions.settings.emojiFor', { name: sound.name })}
            onChange={(e) => setEmoji(e.target.value)} onBlur={() => void save()} onKeyDown={blurOnEnter} />
          <div className="expression-fields">
            <input value={name} maxLength={32} aria-label={t('expressions.settings.nameOf', { name: sound.name })} onChange={(e) => setName(e.target.value)} onBlur={() => void save()} onKeyDown={blurOnEnter} />
            <span className="muted">{t('expressions.settings.seconds', { seconds: formatNumber(sound.durationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })} · {t('expressions.settings.by', { name: server.members[sound.createdBy]?.name ?? t('expressions.settings.formerMember') })}</span>
            {error && <span className="error-text">{error}</span>}
          </div>
        </>
      ) : (
        <div className="expression-fields">
          <span>{sound.emoji ?? '🔊'} {sound.name}</span>
          <span className="muted">{t('expressions.settings.seconds', { seconds: formatNumber(sound.durationMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })} · {t('expressions.settings.by', { name: server.members[sound.createdBy]?.name ?? t('expressions.settings.formerMember') })}</span>
        </div>
      )}
      {canManage && (confirm ? (
        <>
          <button className="button danger small" onClick={() => void deleteSound(server.key, sound.id).catch((e: Error) => setError(errorMessage(e)))}>{t('common.delete')}</button>
          <button className="button small" onClick={() => setConfirm(false)}>{t('expressions.settings.keep')}</button>
        </>
      ) : (
        <button className="icon-button" aria-label={t('expressions.settings.deleteName', { name: sound.name })} title={t('common.delete')} onClick={() => setConfirm(true)}><Trash size={16} /></button>
      ))}
    </li>
  )
}
