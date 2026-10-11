// The soundboard button in the voice bar and call controls, its sound grid, and the "Alice played …" toasts.
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { playSound, stopSounds, useExpressions, useServerSounds, useSoundsPlaying } from '../../state/expressions'
import { useApp } from '../../state/store'
import { useVoice } from '../../state/voice'
import { SoundboardIcon } from './icons'
import { usePopoverPosition } from './popover'
import { useEscapeLayer } from '../layers'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'

export function SoundboardButton({ variant }: { variant: 'bar' | 'call' }) {
  const { t } = useTranslation()
  const session = useVoice((s) => s.session)
  const [open, setOpen] = useState<HTMLElement | null>(null)
  if (!session || !session.canSpeak) return null
  return (
    <>
      <button
        className={`${variant === 'call' ? 'call-button' : 'icon-button'} ${open ? 'on' : ''}`}
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
        aria-label={t('expressions.soundboard.title')}
        aria-expanded={!!open}
        title={t('expressions.soundboard.title')}
        disabled={session.state !== 'connected'}
      >
        <SoundboardIcon />
      </button>
      {open && <SoundboardPanel serverKey={session.serverKey} anchor={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function SoundboardPanel({ serverKey, anchor, onClose }: { serverKey: string; anchor: HTMLElement | null; onClose: () => void }) {
  const { t } = useTranslation()
  const sounds = useServerSounds(serverKey)
  const muted = useExpressions((s) => s.settings.muted)
  const playingCount = useSoundsPlaying((s) => s.count)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cooling, setCooling] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const { style, sheet } = usePopoverPosition(anchor, panel)
  useEscapeLayer(onClose)
  const q = query.trim().toLowerCase()
  const shown = q ? sounds.filter((s) => s.name.toLowerCase().includes(q) || s.emoji?.includes(q)) : sounds

  async function play(id: string) {
    setError(null)
    setCooling(id)
    try {
      await playSound(serverKey, id)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setTimeout(() => setCooling((c) => (c === id ? null : c)), 400)
    }
  }

  return createPortal(
    <div className={`emoji-picker-layer ${sheet ? 'sheet' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className="soundboard"
        style={style}
        role="dialog"
        aria-label={t('expressions.soundboard.title')}
      >
        <header className="soundboard-header">
          <strong>{t('expressions.soundboard.title')}</strong>
          {playingCount > 0 && (
            <button className="button ghost small" onClick={stopSounds} title={t('expressions.soundboard.stopTitle')}>{t('expressions.soundboard.stop')}</button>
          )}
          {sounds.length > 8 && (
            <input className="emoji-search" placeholder={t('expressions.soundboard.search')} aria-label={t('expressions.soundboard.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
        </header>
        {sounds.length === 0 ? (
          <p className="muted soundboard-empty">{t('expressions.soundboard.empty')}</p>
        ) : (
          <div className="soundboard-grid">
            {shown.map((sound) => (
              <button
                key={sound.id}
                className={`sound-button ${cooling === sound.id ? 'playing' : ''}`}
                onClick={() => void play(sound.id)}
                title={t('expressions.soundboard.playTitle', { name: sound.name })}
              >
                <span className="sound-emoji" aria-hidden>{sound.emoji ?? '🔊'}</span>
                <span className="sound-name">{sound.name}</span>
              </button>
            ))}
          </div>
        )}
        {muted && <p className="muted soundboard-note">{t('expressions.soundboard.mutedNote')}</p>}
        {error && <p className="error-text soundboard-note">{error}</p>}
      </div>
    </div>,
    document.body,
  )
}

/** Shows briefly who played which sound, while you're in that call. */
export function SoundToasts() {
  const { t } = useTranslation()
  const played = useExpressions((s) => s.played)
  const servers = useApp((s) => s.servers)
  if (played.length === 0) return null
  return (
    <div className="sound-toasts" aria-live="polite">
      {played.map((p) => (
        <div key={p.key} className="sound-toast">
          <span aria-hidden>{p.sound.emoji ?? '🔊'}</span>
          <span>
            <Trans i18nKey="expressions.soundboard.played" components={{ b: <strong /> }}
              values={{ name: servers[p.serverKey]?.members[p.accountKey]?.name ?? t('common.someone'), sound: p.sound.name }} />
          </span>
        </div>
      ))}
    </div>
  )
}
