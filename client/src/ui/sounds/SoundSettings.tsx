// Choosing notification sounds: yours for messages, mentions and DMs (My settings → Notifications), one for a server or
// a channel (the server and channel menus), and your own uploaded sound. Every choice has a preview.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t as translate } from '../../i18n'
import type { ServerState } from '../../state/store'
import {
  playSound, removeCustomSound, setDefaultSound, setPlaceSound, SoundUploadError, uploadCustomSound, useSounds,
} from '../../state/sounds'
import { overrideAt, resolveSound, SOUND_IDS, SOUND_KINDS, type SoundId, type SoundKind } from '../../state/sounds/soundLogic'
import { MenuItem, MenuTitle } from '../organize/OrgMenu'
import type { Run } from '../organize/Menus'
import './sounds.css'

const soundName = (id: SoundId) => translate(`sounds.names.${id}`)

/** The sounds to offer: your own only once this device has one. */
function useChoices(): SoundId[] {
  const hasCustom = useSounds((s) => !!s.custom)
  return SOUND_IDS.filter((id) => id !== 'custom' || hasCustom)
}

function PreviewButton({ id, label }: { id: SoundId; label: string }) {
  const { t } = useTranslation()
  return (
    <button type="button" className="button small sound-preview" disabled={id === 'none'} onClick={() => playSound(id)}
      aria-label={t('sounds.previewOf', { sound: label })} title={t('sounds.previewOf', { sound: label })}>
      ▶ <span className="sound-preview-label">{t('sounds.preview')}</span>
    </button>
  )
}

/** One row: what it's for, the sound, a preview. `inherit` adds a first choice that follows the level above. */
function SoundRow({ label, value, inherit, onChange, testId }: {
  label: string
  value: SoundId | null
  inherit?: SoundId
  onChange: (id: SoundId | null) => void
  testId?: string
}) {
  const { t } = useTranslation()
  const choices = useChoices()
  const playing = value ?? inherit ?? 'classic'
  return (
    <div className="sound-row" data-testid={testId}>
      <label className="sound-row-label">
        <span>{label}</span>
        <select value={value ?? ''} onChange={(e) => {
          const next = (e.target.value || null) as SoundId | null
          onChange(next)
          playSound(next ?? inherit ?? 'classic')
        }}>
          {inherit && <option value="">{t('sounds.inherit', { sound: soundName(inherit) })}</option>}
          {choices.map((id) => <option key={id} value={id}>{soundName(id)}</option>)}
          {value === 'custom' && !choices.includes('custom') && <option value="custom">{t('sounds.customMissing')}</option>}
        </select>
      </label>
      <PreviewButton id={playing} label={soundName(playing)} />
    </div>
  )
}

/** My settings → Notifications: your sounds and your own sound (servers and channels: their menus). */
export function SoundSettings() {
  const { t } = useTranslation()
  const prefs = useSounds((s) => s.prefs)
  const kindLabel = (kind: SoundKind) => t(`sounds.kinds.${kind}`)
  return (
    <div className="sound-settings" role="group" aria-label={t('sounds.heading')}>
      <h3 className="h4">{t('sounds.heading')}</h3>
      {SOUND_KINDS.map((kind) => (
        <SoundRow key={kind} label={kindLabel(kind)} value={prefs[kind]} testId={`sound-${kind}`}
          onChange={(id) => setDefaultSound(kind, id ?? 'classic')} />
      ))}
      <p className="muted sound-hint">{t('sounds.syncHint')}</p>
      <CustomSoundSettings />
    </div>
  )
}

function CustomSoundSettings() {
  const { t } = useTranslation()
  const custom = useSounds((s) => s.custom)
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await uploadCustomSound(file)
      playSound('custom')
    } catch (e) {
      setError(t(`sounds.custom.problems.${e instanceof SoundUploadError ? e.problem : 'unreadable'}`))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="sound-custom" data-testid="sound-custom">
      <strong className="sound-custom-title">{t('sounds.custom.heading')}</strong>
      <div className="sound-custom-row">
        {custom && <span className="sound-custom-name">{t('sounds.custom.current', { name: custom.name, seconds: custom.seconds })}</span>}
        <button type="button" className="button small" disabled={busy} onClick={() => input.current?.click()}>
          {custom ? t('sounds.custom.replace') : t('sounds.custom.upload')}
        </button>
        {custom && <PreviewButton id="custom" label={soundName('custom')} />}
        {custom && <button type="button" className="button small" onClick={removeCustomSound}>{t('sounds.custom.remove')}</button>}
        <input ref={input} type="file" hidden accept="audio/*,.mp3,.ogg,.oga,.opus,.wav,.m4a,.aac,.webm,.flac" aria-label={t('sounds.custom.upload')}
          onChange={(e) => {
            void pick(e.target.files?.[0])
            e.target.value = ''
          }} />
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="muted sound-hint">{t('sounds.custom.hint')}</p>
    </div>
  )
}

/** The server or channel menu's "Sound" page: inherit, or pick one (it plays as you pick). */
export function SoundMenuView({ server, channelId, back, run }: { server: ServerState; channelId: number | null; back: () => void; run: Run }) {
  const { t } = useTranslation()
  const prefs = useSounds((s) => s.prefs)
  const choices = useChoices()
  const own = overrideAt(prefs, server.key, channelId)
  // What "default" means here: the server's sound for a channel, yours for the server.
  const inherited = channelId === null ? prefs.message : resolveSound(prefs, 'message', { serverKey: server.key })
  const pick = (id: SoundId | null) => run(() => {
    setPlaceSound(server.key, channelId, id)
    playSound(id ?? inherited)
  })
  const channel = channelId === null ? null : server.channels.find((c) => c.id === channelId)
  const place = channel ? (channel.kind === 'text' ? `#${channel.name}` : channel.name) : server.name
  return (
    <>
      <MenuTitle onBack={back}>{t('sounds.menuTitle', { place })}</MenuTitle>
      <div className="org-list" role="menu">
        <MenuItem checked={own === null} onClick={pick(null)} hint={soundName(inherited)}>
          {channelId === null ? t('sounds.yourDefault') : t('sounds.serverDefault')}
        </MenuItem>
        {choices.map((id) => <MenuItem key={id} checked={own === id} onClick={pick(id)}>{soundName(id)}</MenuItem>)}
      </div>
    </>
  )
}

/** The row in the server and channel menus. */
export function SoundMenuRow({ server, channelId, open }: { server: ServerState; channelId: number | null; open: () => void }) {
  const { t } = useTranslation()
  const prefs = useSounds((s) => s.prefs)
  const playing = resolveSound(prefs, 'message', { serverKey: server.key, channelId })
  return <MenuItem onClick={open} hint={soundName(playing)} submenu>{t('sounds.menuRow')}</MenuItem>
}
