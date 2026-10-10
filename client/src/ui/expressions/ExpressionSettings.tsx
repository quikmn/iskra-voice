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

const MAX_EMOJIS = 200

export function SoundboardSettingsSection() {
  const { volume, muted } = useExpressions((s) => s.settings)
  return (
    <section className="settings-section">
      <h3>Soundboard</h3>
      <label className="field">
        <span>Soundboard volume · {Math.round(volume * 100)}%</span>
        <input
          type="range" min={0} max={100} step={5} value={Math.round(volume * 100)} disabled={muted}
          aria-label="Soundboard volume"
          onChange={(e) => updateSoundboardSettings({ volume: Number(e.target.value) / 100 })}
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={muted} onChange={(e) => updateSoundboardSettings({ muted: e.target.checked })} />
        Mute the soundboard (you won't hear sounds others play)
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

function EmojiSection({ server }: { server: ServerState }) {
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
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h3>Server emoji · {emojis.length} / {MAX_EMOJIS}</h3>
      <p className="muted">Use them anywhere on this server as <code>:name:</code>. PNG, GIF or WebP up to 256 KB; bigger still images are shrunk to 128×128.</p>
      <input ref={input} type="file" hidden accept="image/png,image/gif,image/webp,image/jpeg" aria-label="Emoji image" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = '' }} />
      {pending ? (
        <div className="expression-new">
          <img className="custom-emoji big" src={pending.preview} alt="" />
          <input
            value={pending.name} maxLength={32} aria-label="Emoji name"
            onChange={(e) => setPending({ ...pending, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
            onKeyDown={(e) => e.key === 'Enter' && void upload()}
          />
          <button className="button primary" disabled={busy || !nameValid} onClick={() => void upload()}>{busy ? 'Adding…' : 'Add'}</button>
          <button className="button" disabled={busy} onClick={() => { URL.revokeObjectURL(pending.preview); setPending(null) }}>Cancel</button>
        </div>
      ) : (
        <button className="button" disabled={emojis.length >= MAX_EMOJIS} onClick={() => input.current?.click()}>Upload emoji</button>
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
  const [name, setName] = useState(emoji.name)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  async function rename() {
    if (name === emoji.name) return
    try {
      await renameEmoji(server.key, emoji.id, name)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
      setName(emoji.name)
    }
  }

  return (
    <li className="expression-row">
      <img className="custom-emoji big" src={serverFileUrl(server.key, emoji.url) ?? undefined} alt={`:${emoji.name}:`} />
      <div className="expression-fields">
        <input
          value={name} maxLength={32} aria-label={`Name of :${emoji.name}:`}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          onBlur={() => void rename()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="muted">by {server.members[emoji.createdBy]?.name ?? 'a former member'}</span>
        {error && <span className="error-text">{error}</span>}
      </div>
      {confirm ? (
        <>
          <button className="button danger small" onClick={() => void deleteEmoji(server.key, emoji.id).catch((e: Error) => setError(e.message))}>Delete</button>
          <button className="button small" onClick={() => setConfirm(false)}>Keep</button>
        </>
      ) : (
        <button className="icon-button" aria-label={`Delete :${emoji.name}:`} title="Delete" onClick={() => setConfirm(true)}><Trash size={16} /></button>
      )}
    </li>
  )
}

function SoundsSection({ server }: { server: ServerState }) {
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
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section">
      <h3>Soundboard sounds · {sounds.length}</h3>
      <p className="muted">Anyone who can talk in a voice channel can play these for the call. MP3, Ogg or WAV, up to 5 seconds and 512 KB.</p>
      <input ref={input} type="file" hidden accept="audio/mpeg,audio/ogg,audio/wav,audio/x-wav,.mp3,.ogg,.wav" aria-label="Sound file"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) setPending({ file, name: file.name.replace(/\.\w+$/, '').slice(0, 32), emoji: '' })
        }} />
      {pending ? (
        <div className="expression-new">
          <input className="sound-emoji-input" value={pending.emoji} maxLength={16} placeholder="🔊" aria-label="Sound emoji" onChange={(e) => setPending({ ...pending, emoji: e.target.value })} />
          <input value={pending.name} maxLength={32} aria-label="Sound name" onChange={(e) => setPending({ ...pending, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void upload()} />
          <button className="button primary" disabled={busy || !pending.name.trim()} onClick={() => void upload()}>{busy ? 'Adding…' : 'Add'}</button>
          <button className="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
        </div>
      ) : (
        <button className="button" onClick={() => input.current?.click()}>Upload sound</button>
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
      setError((e as Error).message)
      setName(sound.name)
      setEmoji(sound.emoji ?? '')
    }
  }

  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur()

  return (
    <li className="expression-row">
      <button className="icon-button" aria-label={`Preview ${sound.name}`} title="Preview (only you hear it)" disabled={!url} onClick={() => url && playUrl(url, undefined, sound.durationMs)}>
        <Play size={16} />
      </button>
      {canManage ? (
        <>
          <input className="sound-emoji-input" value={emoji} maxLength={16} placeholder="🔊" aria-label={`Emoji for ${sound.name}`}
            onChange={(e) => setEmoji(e.target.value)} onBlur={() => void save()} onKeyDown={blurOnEnter} />
          <div className="expression-fields">
            <input value={name} maxLength={32} aria-label={`Name of ${sound.name}`} onChange={(e) => setName(e.target.value)} onBlur={() => void save()} onKeyDown={blurOnEnter} />
            <span className="muted">{(sound.durationMs / 1000).toFixed(1)} s · by {server.members[sound.createdBy]?.name ?? 'a former member'}</span>
            {error && <span className="error-text">{error}</span>}
          </div>
        </>
      ) : (
        <div className="expression-fields">
          <span>{sound.emoji ?? '🔊'} {sound.name}</span>
          <span className="muted">{(sound.durationMs / 1000).toFixed(1)} s · by {server.members[sound.createdBy]?.name ?? 'a former member'}</span>
        </div>
      )}
      {canManage && (confirm ? (
        <>
          <button className="button danger small" onClick={() => void deleteSound(server.key, sound.id).catch((e: Error) => setError(e.message))}>Delete</button>
          <button className="button small" onClick={() => setConfirm(false)}>Keep</button>
        </>
      ) : (
        <button className="icon-button" aria-label={`Delete ${sound.name}`} title="Delete" onClick={() => setConfirm(true)}><Trash size={16} /></button>
      ))}
    </li>
  )
}
