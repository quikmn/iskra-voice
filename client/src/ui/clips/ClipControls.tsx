// Clips in the call UI: the button, the "clips on" strip and marks, "saved a clip" toasts, and the clip dialog.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { useApp } from '../../state/store'
import { useVoice } from '../../state/voice'
import { nameOf } from '../../state/dms'
import {
  canClip, clearClipError, clipFile, closeClip, downloadClip, saveClip, setClipSettings, shareClip, useClips,
} from '../../state/clips'
import { callPlace, clipsOnIn, clipTime } from '../../state/clipsLogic'
import { clampTrim, trimDraft } from '../../state/clips/ring'
import { Modal } from '../bits'
import { Close, Send } from '../icons'
import { ClipIcon, DownloadIcon } from './clipIcons'
import './clips.css'

/** The call button: saves the last N seconds (or offers to turn clips on). */
export function ClipButton() {
  const { t } = useTranslation()
  const enabled = useClips((s) => s.settings.enabled)
  const seconds = useClips((s) => s.settings.seconds)
  const busy = useClips((s) => s.busy)
  if (!canClip()) return null
  const label = enabled ? t('clips.button', { seconds }) : t('clips.buttonOff')
  return (
    <button className={`call-button clip-button ${enabled ? '' : 'idle'}`} onClick={() => void saveClip()} disabled={busy} aria-label={label} title={label}>
      <ClipIcon />
    </button>
  )
}

/** Who has clips on, in the call you're in (you included). */
function useClipsOn(): string[] {
  const session = useVoice((s) => s.session)
  const roomClips = useClips((s) => s.roomClips)
  const mine = useClips((s) => s.settings.enabled) && canClip()
  const participants = useApp((s) => (session ? s.servers[session.serverKey]?.voice[session.channelId] : undefined))
  const me = useApp((s) => (session ? s.servers[session.serverKey]?.me?.accountKey ?? null : null))
  return useMemo(
    () => (session ? clipsOnIn(callPlace(session), participants ?? [], roomClips, me, mine) : []),
    [session, participants, roomClips, me, mine],
  )
}

/** Above the call controls while anyone in the call has clips on: everyone is told, every time. */
export function ClipsStrip() {
  const { t } = useTranslation()
  const on = useClipsOn()
  const session = useVoice((s) => s.session)
  const me = useApp((s) => (session ? s.servers[session.serverKey]?.me?.accountKey : undefined))
  if (on.length === 0) return null
  const names = on.map((k) => (k === me ? t('clips.you') : nameOf(k)))
  return (
    <div className="clips-strip" role="status">
      <span className="clips-dot" aria-hidden />
      <span>{t('clips.onFor', { names: names.join(', ') })}</span>
    </div>
  )
}

/** The small mark next to someone's name in the call. */
export function ClipsMark({ on }: { on?: boolean }) {
  const { t } = useTranslation()
  if (!on) return null
  return <span className="clips-mark" role="img" aria-label={t('clips.mark')} title={t('clips.mark')} />
}

/** Toasts, errors and the dialog, wherever you are in the app. */
export function ClipLayer() {
  const { t } = useTranslation()
  const notices = useClips((s) => s.notices)
  const error = useClips((s) => s.error)
  const draft = useClips((s) => s.draft)
  const enabled = useClips((s) => s.settings.enabled)
  const inCall = useVoice((s) => !!s.session)

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(clearClipError, 7000)
    return () => clearTimeout(timer)
  }, [error])

  return (
    <>
      {(notices.length > 0 || error) && (
        <div className="clip-toasts" aria-live="polite">
          {notices.map((n) => (
            <div key={n.id} className="clip-toast"><ClipIcon size={15} /> {t('clips.saved', { name: nameOf(n.accountKey) })}</div>
          ))}
          {error && (
            <div className="clip-toast error" role="alert">
              <span>{typeof error === 'string' ? error : t(error.key)}</span>
              {!enabled && inCall && canClip() && (
                <button className="button small primary" onClick={() => setClipSettings({ enabled: true })}>{t('clips.turnOn')}</button>
              )}
              <button className="icon-button small" onClick={clearClipError} aria-label={t('common.close')}><Close size={14} /></button>
            </div>
          )}
        </div>
      )}
      {draft && <ClipDialog key={draft.at} />}
    </>
  )
}

function ClipDialog() {
  const { t } = useTranslation()
  const draft = useClips((s) => s.draft)!
  const { clip, place, at } = draft
  const full = useMemo(() => clipFile(clip, at), [clip, at])
  const [range, setRange] = useState({ from: 0, to: clip.duration })
  const [busy, setBusy] = useState<'save' | 'share' | null>(null)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement | null>(null)
  // The preview's blob URL lives as long as the element shows this clip.
  const attach = useCallback((element: HTMLVideoElement | null) => {
    video.current = element
    if (!element) return
    const url = URL.createObjectURL(full)
    element.src = url
    return () => URL.revokeObjectURL(url)
  }, [full])
  const trimmed = range.from > 0 || range.to < clip.duration

  const output = () => (trimmed ? clipFile(trimDraft(clip, range.from, range.to).draft, at) : full)

  function setFrom(value: number) {
    const next = clampTrim(clip.duration, value, Math.max(range.to, value))
    setRange(next)
    if (video.current) video.current.currentTime = next.from / 1000
  }
  function setTo(value: number) {
    setRange(clampTrim(clip.duration, Math.min(range.from, value), value))
  }

  async function save() {
    setBusy('save')
    setError(null)
    try {
      await downloadClip(output())
      setDone(t('clips.dialog.savedFile'))
    } catch (e) {
      setError(errorMessage(e))
    }
    setBusy(null)
  }

  async function share() {
    setBusy('share')
    setError(null)
    setProgress(0)
    try {
      await shareClip(output(), place, setProgress)
      setDone(t('clips.dialog.shared'))
    } catch (e) {
      setError(errorMessage(e))
    }
    setBusy(null)
  }

  const step = 100
  const hasVideo = !!clip.video
  return (
    <Modal
      title={t('clips.dialog.title')}
      onClose={closeClip}
      className="clip-dialog"
      footer={
        <>
          <button className="button ghost" onClick={closeClip}>{done ? t('common.close') : t('clips.dialog.discard')}</button>
          <button className="button" onClick={() => void share()} disabled={!!busy}>
            <Send size={16} /> {busy === 'share' ? t('clips.dialog.sharing', { percent: Math.round(progress * 100) }) : t('clips.dialog.share')}
          </button>
          <button className="button primary" onClick={() => void save()} disabled={!!busy}>
            <DownloadIcon size={16} /> {t('clips.dialog.save')}
          </button>
        </>
      }
    >
      <video
        ref={attach}
        className={`clip-preview ${hasVideo ? '' : 'audio-only'}`}
        controls
        playsInline
        aria-label={t('clips.dialog.preview')}
        onTimeUpdate={(e) => {
          const el = e.currentTarget
          if (el.currentTime * 1000 > range.to + 50) {
            el.pause()
            el.currentTime = range.from / 1000
          }
        }}
        onPlay={(e) => {
          const el = e.currentTarget
          if (el.currentTime * 1000 < range.from - 50 || el.currentTime * 1000 >= range.to) el.currentTime = range.from / 1000
        }}
      />
      {!hasVideo && <p className="muted clip-note">{t('clips.dialog.audioOnly')}</p>}
      <div className="clip-trim" role="group" aria-label={t('clips.dialog.trim')}>
        <label className="field">
          <span>{t('clips.dialog.start', { time: clipTime(range.from) })}</span>
          <input type="range" min={0} max={clip.duration} step={step} value={range.from} onChange={(e) => setFrom(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>{t('clips.dialog.end', { time: clipTime(range.to) })}</span>
          <input type="range" min={0} max={clip.duration} step={step} value={range.to} onChange={(e) => setTo(Number(e.target.value))} />
        </label>
      </div>
      <p className="muted clip-note">
        {t('clips.dialog.length', { time: clipTime(range.to - range.from) })} · {t('clips.dialog.local')}
      </p>
      {done && <p className="clip-done" role="status">{done}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}
