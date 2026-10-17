// Voice messages: the mic button and recording bar in the composer, and the inline player in messages.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { VoiceInfo } from '../../../core/protocol'
import { t as translate } from '../../../i18n'
import { errorMessage } from '../../../i18n/errors'
import { formatNumber } from '../../../i18n/format'
import { fileUrl, type PendingMessage, type ServerState } from '../../../state/store'
import { Mic, Send, Trash } from '../../icons'
import { useEscapeLayer } from '../../layers'
import { Spinner } from '../../bits'
import { VoiceRecorder, type Recording } from './recorder'
import { CANCEL_SLIDE_PX, MAX_VOICE_MS, decodeWaveform, formatDuration, nextRate, releaseAction } from './voiceMessage'
import './voice-messages.css'

type Mode = 'idle' | 'starting' | 'holding' | 'locked' | 'sending'

function micError(e: unknown): string {
  const name = (e as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return translate('chat.voice.micBlocked')
  if (name === 'NotFoundError') return translate('chat.voice.noMic')
  return translate('chat.voice.startFailed')
}

/**
 * Hold to record and let go to send; slide left to cancel. A short tap keeps recording with cancel and send buttons
 * (also what keyboard users get). Stops and sends by itself at 5 minutes.
 */
/** `startSignal`: each change (not the value it mounts with) starts a recording, as a tap would (the phone "+" menu). */
export function VoiceRecordButton({ onSend, disabled, startSignal = 0 }: { onSend: (recording: Recording) => Promise<void>; disabled?: boolean; startSignal?: number }) {
  const [mode, setMode] = useState<Mode>('idle')
  const [error, setError] = useState<string | null>(null)
  const [levels, setLevels] = useState<number[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [slide, setSlide] = useState(0)
  const recorder = useRef<VoiceRecorder | null>(null)
  const press = useRef<{ x: number; at: number } | null>(null)
  const recording = mode === 'holding' || mode === 'locked' || mode === 'starting'
  const { t } = useTranslation()
  useEscapeLayer(() => cancel(), recording)

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setElapsed(recorder.current?.elapsed ?? 0), 200)
    return () => clearInterval(timer)
  }, [recording])

  useEffect(() => () => recorder.current?.cancel(), [])

  const started = useRef(startSignal)
  useEffect(() => {
    if (startSignal === started.current) return
    started.current = startSignal
    if (mode === 'idle' && !disabled) void begin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSignal])

  async function begin() {
    setError(null)
    setLevels([])
    setElapsed(0)
    setSlide(0)
    const r = new VoiceRecorder((level) => setLevels((l) => [...l.slice(-39), level]), () => void finish())
    recorder.current = r
    setMode('starting')
    try {
      await r.start()
    } catch (e) {
      if (recorder.current === r) recorder.current = null
      setMode('idle')
      setError(micError(e))
      return
    }
    if (recorder.current !== r) return // cancelled while the microphone opened
    // Still held: release sends. Already let go (a tap, or a permission prompt in between): keep recording.
    setMode(press.current ? 'holding' : 'locked')
  }

  async function finish() {
    const r = recorder.current
    if (!r) return
    recorder.current = null
    press.current = null
    setMode('sending')
    try {
      const result = await r.stop()
      if (!result) {
        setError(t('chat.voice.tooShort'))
        return
      }
      await onSend(result)
    } catch (e) {
      setError((e as Error)?.message ? errorMessage(e) : t('chat.voice.sendFailed'))
    } finally {
      setMode('idle')
    }
  }

  function cancel() {
    recorder.current?.cancel()
    recorder.current = null
    press.current = null
    setMode('idle')
  }

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (mode !== 'idle' || e.button !== 0 || disabled) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    press.current = { x: e.clientX, at: performance.now() }
    void begin()
  }
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!press.current) return
    const slid = Math.max(0, press.current.x - e.clientX)
    setSlide(slid)
    if (slid >= CANCEL_SLIDE_PX) cancel()
  }
  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const p = press.current
    if (!p) return
    press.current = null
    const action = releaseAction(performance.now() - p.at, Math.max(0, p.x - e.clientX))
    if (action === 'cancel') cancel()
    else if (mode === 'starting') return // begin() locks once the mic is open
    else if (action === 'lock') setMode('locked')
    else void finish()
  }
  const onPointerCancel = () => {
    // The browser took the gesture (a scroll, a system sheet): keep recording, with buttons.
    if (!press.current) return
    press.current = null
    if (mode === 'holding') setMode('locked')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && mode === 'idle' && !disabled) {
      e.preventDefault()
      void begin()
    }
  }

  const left = Math.max(0, MAX_VOICE_MS - elapsed)
  return (
    <>
      <button
        className={`icon-button attach-button voice-record-button ${mode === 'holding' ? 'holding' : ''}`}
        aria-label={t('chat.voice.record')}
        title={t('chat.voice.recordTitle')}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Mic />
      </button>
      {mode !== 'idle' && (
        <div className={`voice-recording ${mode}`} role="group" aria-label={t('chat.voice.recording')}>
          {mode === 'locked' && (
            <button className="icon-button voice-cancel" onClick={cancel} aria-label={t('chat.voice.cancelRecording')} title={t('common.cancel')}>
              <Trash />
            </button>
          )}
          <span className="voice-rec-dot" aria-hidden />
          <span className="voice-rec-time" aria-live="off">{formatDuration(elapsed)}</span>
          <span className="voice-live-bars" aria-hidden>
            {levels.map((l, i) => <span key={i} style={{ height: `${Math.max(8, l * 100)}%` }} />)}
          </span>
          {mode === 'holding' && (
            <span className="voice-slide-hint" style={{ opacity: 1 - Math.min(0.8, slide / CANCEL_SLIDE_PX), transform: `translateX(${-Math.min(slide, CANCEL_SLIDE_PX) / 3}px)` }}>
              ‹ {t('chat.voice.slideToCancel')}
            </span>
          )}
          {mode === 'locked' && left < 30_000 && <span className="voice-rec-left">{t('chat.voice.left', { time: formatDuration(left) })}</span>}
          {mode === 'starting' && <span className="voice-slide-hint">{t('chat.voice.opening')}</span>}
          {mode === 'sending' && <span className="voice-slide-hint"><Spinner /> {t('chat.voice.sending')}</span>}
          {mode === 'locked' && (
            <button className="send-button voice-send" onClick={() => void finish()} aria-label={t('chat.voice.send')} title={t('common.send')}>
              <Send />
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="voice-error" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>{t('chat.voice.dismiss')}</button>
        </div>
      )}
    </>
  )
}

// ── Player ──────────────────────────────────────────────────────────────────

const RATE_KEY = 'iskra.voiceRate'
const loadRate = () => {
  try {
    const r = Number(localStorage.getItem(RATE_KEY))
    return r === 1.5 || r === 2 ? r : 1
  } catch {
    return 1
  }
}

const PLAY_EVENT = 'iskra:voice-play'
const BARS = 40

export function VoiceMessage({ server, message }: { server: ServerState; message: PendingMessage }) {
  const file = message.attachments[0]
  if (!message.voice || !file) return null
  return <VoicePlayer src={message.tempId ? null : fileUrl(server.key, file)} voice={message.voice} />
}

/** Play/pause, a waveform you can scrub (pointer or arrow keys), the time and the speed. */
export function VoicePlayer({ src, voice }: { src: string | null; voice: VoiceInfo }) {
  const audio = useRef<HTMLAudioElement>(null)
  const wave = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [rate, setRate] = useState(loadRate)
  const [failed, setFailed] = useState(false)
  const { t } = useTranslation()
  const bars = decodeWaveform(voice.waveform, BARS)
  const duration = voice.duration
  const progress = Math.min(1, position / duration)

  useEffect(() => {
    // One voice message plays at a time.
    const other = (e: Event) => (e as CustomEvent).detail !== audio.current && audio.current?.pause()
    window.addEventListener(PLAY_EVENT, other)
    return () => window.removeEventListener(PLAY_EVENT, other)
  }, [])

  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      if (audio.current) setPosition(Math.min(duration, audio.current.currentTime * 1000))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, duration])

  async function toggle() {
    const el = audio.current
    if (!el || !src) return
    if (!el.paused) return el.pause()
    if (position >= duration - 50) seek(0)
    el.playbackRate = rate
    window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: el }))
    try {
      await el.play()
    } catch {
      setFailed(true)
    }
  }

  function seek(ms: number) {
    const clamped = Math.max(0, Math.min(duration, ms))
    setPosition(clamped)
    if (audio.current) audio.current.currentTime = clamped / 1000
  }

  function seekFromPointer(e: PointerEvent<HTMLDivElement>) {
    const rect = wave.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    seek(((e.clientX - rect.left) / rect.width) * duration)
  }

  function changeRate() {
    const next = nextRate(rate)
    setRate(next)
    if (audio.current) audio.current.playbackRate = next
    try {
      localStorage.setItem(RATE_KEY, String(next))
    } catch {
      /* private mode */
    }
  }

  return (
    <div className={`voice-player ${playing ? 'playing' : ''}`}>
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setPosition(duration)
          }}
          onError={() => setFailed(true)}
        />
      )}
      <button className="voice-play" onClick={() => void toggle()} disabled={!src} aria-label={playing ? t('chat.voice.pause') : t('chat.voice.play')}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div
        ref={wave}
        className="voice-wave"
        role="slider"
        tabIndex={0}
        aria-label={t('chat.voice.position')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration / 1000)}
        aria-valuenow={Math.round(position / 1000)}
        aria-valuetext={t('chat.voice.positionOf', { position: formatDuration(position), duration: formatDuration(duration) })}
        onPointerDown={(e) => {
          if (!src) return
          e.currentTarget.setPointerCapture(e.pointerId)
          seekFromPointer(e)
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && seekFromPointer(e)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault()
            seek(position + (e.key === 'ArrowRight' ? 5000 : -5000))
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault()
            seek(e.key === 'Home' ? 0 : duration)
          }
        }}
      >
        {bars.map((h, i) => (
          <span key={i} className={(i + 0.5) / BARS <= progress ? 'played' : ''} style={{ height: `${Math.max(10, h * 100)}%` }} />
        ))}
      </div>
      <span className="voice-time">{failed ? t('chat.voice.cantPlay') : formatDuration(playing || position > 0 ? position : duration)}</span>
      <button className="voice-rate" onClick={changeRate} aria-label={t('chat.voice.speedLabel', { rate: formatNumber(rate) })} title={t('chat.voice.speed')}>
        {formatNumber(rate)}×
      </button>
    </div>
  )
}

const PlayIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor" /></svg>
)
const PauseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><rect x="5" y="4" width="5" height="16" rx="1.2" fill="currentColor" /><rect x="14" y="4" width="5" height="16" rx="1.2" fill="currentColor" /></svg>
)
