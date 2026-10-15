// The main window's pop-out buttons: the voice/call panel, one video, a text channel. Each is hidden where that
// pop-out can't open (state/popoutLogic.ts: popoutMode).
import { useEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { popoutModeFor, togglePopout, usePoppedOut } from '../../state/popouts'
import type { Tile } from '../../state/voice'
import { PopOutIcon, PopInIcon } from './popoutIcons'

/** The voice/call panel in its own window (desktop) or picture-in-picture (Chromium). */
export function VoicePopoutButton({ className = 'icon-button' }: { className?: string }) {
  const { t } = useTranslation()
  const on = usePoppedOut({ kind: 'voice' })
  if (!popoutModeFor('voice')) return null
  const label = on ? t('popout.popIn') : t('popout.popOutVoice')
  return (
    <button className={`${className} ${on ? 'on' : ''}`} onClick={() => void togglePopout({ kind: 'voice' })} aria-pressed={on} aria-label={label} title={label} data-testid="voice-popout">
      {on ? <PopInIcon /> : <PopOutIcon />}
    </button>
  )
}

/** One video in its own window, the browser's picture-in-picture window, or (elsewhere) the video's own picture-in-picture. */
export function VideoPopoutButton({ tile, video }: { tile: Tile; video: RefObject<HTMLVideoElement | null> }) {
  const { t } = useTranslation()
  const target = { kind: 'stream' as const, tileId: tile.id }
  const popped = usePoppedOut(target)
  const pip = useVideoPip(video)
  const mode = popoutModeFor('stream')
  if (!mode) return null
  const on = mode === 'video' ? pip : popped
  const label = on ? t('popout.popIn') : mode === 'video' ? t('popout.pictureInPicture') : t('popout.popOutVideo')
  const toggle = () => {
    if (mode !== 'video') return void togglePopout(target)
    const element = video.current
    if (!element) return
    if (document.pictureInPictureElement === element) void document.exitPictureInPicture().catch(() => undefined)
    else void element.requestPictureInPicture().catch(() => undefined)
  }
  return (
    <button
      className={`icon-button tile-popout ${on ? 'on' : ''}`}
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        toggle()
      }}
    >
      {on ? <PopInIcon size={16} /> : <PopOutIcon size={16} />}
    </button>
  )
}

/** Whether this <video> is in the browser's own picture-in-picture right now. */
function useVideoPip(video: RefObject<HTMLVideoElement | null>): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const element = video.current
    if (!element) return
    const update = () => setOn(document.pictureInPictureElement === element)
    element.addEventListener('enterpictureinpicture', update)
    element.addEventListener('leavepictureinpicture', update)
    return () => {
      element.removeEventListener('enterpictureinpicture', update)
      element.removeEventListener('leavepictureinpicture', update)
    }
  }, [video])
  return on
}

/** A text channel in its own window (desktop app only). */
export function ChannelPopoutButton({ serverKey, channelId }: { serverKey: string; channelId: number }) {
  const { t } = useTranslation()
  const target = { kind: 'chat' as const, serverKey, channelId }
  const on = usePoppedOut(target)
  if (popoutModeFor('chat') !== 'window') return null
  const label = on ? t('popout.popIn') : t('popout.popOutChannel')
  return (
    <button className={`icon-button ${on ? 'on' : ''}`} onClick={() => void togglePopout(target)} aria-pressed={on} aria-label={label} title={label}>
      {on ? <PopInIcon /> : <PopOutIcon />}
    </button>
  )
}
