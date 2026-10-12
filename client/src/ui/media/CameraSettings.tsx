// Settings → Camera: which camera, its background (off, blur, or a picture or colour behind you) and a live preview
// that runs the same effect as calls. Everything happens on this device.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activeLook, switchCamera, updateBackground, useBackground } from '../../state/background'
import type { Backdrop, BackgroundMode } from '../../state/video/effects'
import { BackgroundProcessor, effectsSupported } from '../../state/video/processor'
import { useVoice } from '../../state/voice'
import './media.css'

const MODES: { id: BackgroundMode; label: 'media.background.off' | 'media.background.blur' | 'media.background.replace' }[] = [
  { id: 'off', label: 'media.background.off' },
  { id: 'blur', label: 'media.background.blur' },
  { id: 'replace', label: 'media.background.replace' },
]

const BACKDROPS: { id: Backdrop; label: 'media.background.aurora' | 'media.background.sunset' | 'media.background.color' }[] = [
  { id: 'aurora', label: 'media.background.aurora' },
  { id: 'sunset', label: 'media.background.sunset' },
  { id: 'color', label: 'media.background.color' },
]

function useCameras(refresh: unknown): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const media = navigator.mediaDevices
    if (!media?.enumerateDevices) return
    let alive = true
    const load = () => void media.enumerateDevices().then((d) => alive && setDevices(d.filter((x) => x.kind === 'videoinput' && x.deviceId)), () => undefined)
    load()
    media.addEventListener?.('devicechange', load)
    return () => {
      alive = false
      media.removeEventListener?.('devicechange', load)
    }
  }, [refresh])
  return devices
}

/** The camera with the chosen effect, while `on`: the same processor calls use. */
function Preview({ on, onError }: { on: boolean; onError: (message: string | null) => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLVideoElement>(null)
  const settings = useBackground((s) => s.settings)
  const slow = useBackground((s) => s.slow)
  const look = useMemo(() => activeLook({ settings, slow, notice: null, stats: null }), [settings, slow])
  const camera = settings.camera
  const lookRef = useRef(look)
  const processor = useRef<BackgroundProcessor | null>(null)
  const effectOn = !!look

  useEffect(() => {
    lookRef.current = look
    if (look) processor.current?.setLook(look)
  }, [look])

  useEffect(() => {
    const video = ref.current
    if (!on || !video) return
    let alive = true
    let stream: MediaStream | null = null
    let p: BackgroundProcessor | null = null
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: camera ? { deviceId: { ideal: camera } } : true })
        if (!alive) return
        const track = stream.getVideoTracks()[0]
        let shown: MediaStreamTrack = track
        const current = lookRef.current
        if (effectOn && current) {
          p = new BackgroundProcessor(current)
          await p.init({ kind: 'video' as never, track })
          if (!alive) return
          processor.current = p
          shown = p.processedTrack ?? track
        }
        video.srcObject = new MediaStream([shown])
        onError(null)
      } catch {
        onError(t('media.background.noCamera'))
      }
    })()
    return () => {
      alive = false
      processor.current = null
      void p?.destroy()
      stream?.getTracks().forEach((track) => track.stop())
      video.srcObject = null
    }
  }, [on, camera, effectOn, onError, t])

  if (!on) return null
  return (
    <div className="camera-preview">
      <video ref={ref} autoPlay playsInline muted aria-label={t('media.background.previewLabel')} data-effect={look?.mode ?? 'off'} />
    </div>
  )
}

export function CameraSettingsSection() {
  const { t } = useTranslation()
  const settings = useBackground((s) => s.settings)
  const slow = useBackground((s) => s.slow)
  const stats = useBackground((s) => s.stats)
  const inCall = useVoice((s) => s.session?.state === 'connected')
  const cameraOn = useVoice((s) => s.camera)
  const [previewing, setPreviewing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cameras = useCameras(previewing)
  const supported = effectsSupported()
  const known = !settings.camera || cameras.some((c) => c.deviceId === settings.camera)

  return (
    <>
      <section className="settings-section media-settings">
        <h3>{t('media.background.camera')}</h3>
        <label className="field">
          <span>{t('media.background.camera')}</span>
          <select value={known ? settings.camera : ''} onChange={(e) => void switchCamera(e.target.value)}>
            <option value="">{t('settings.audio.systemDefault')}</option>
            {cameras.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || t('media.background.cameraN', { n: i + 1 })}</option>)}
          </select>
        </label>
        <Preview on={previewing} onError={setError} />
        <div className="copy-row">
          <button className={`button ${previewing ? '' : 'primary'}`} aria-pressed={previewing} onClick={() => setPreviewing(!previewing)}>
            {previewing ? t('media.background.stopPreview') : t('media.background.preview')}
          </button>
          <small className="muted">{t('media.background.previewHint')}</small>
        </div>
        {error && previewing && <p className="muted" role="status">{error}</p>}
      </section>

      <section className="settings-section media-settings">
        <h3>{t('media.background.title')}</h3>
        <p className="muted">{t('media.background.hint')}</p>
        <div className="segmented" role="radiogroup" aria-label={t('media.background.title')}>
          {MODES.map((m) => (
            <button key={m.id} role="radio" aria-checked={settings.mode === m.id} className={settings.mode === m.id ? 'on' : ''}
              disabled={m.id !== 'off' && !supported} onClick={() => updateBackground({ mode: m.id })}>
              {t(m.label)}
            </button>
          ))}
        </div>
        {settings.mode === 'replace' && (
          <div className="backdrops" role="radiogroup" aria-label={t('media.background.picture')}>
            {BACKDROPS.map((b) => (
              <button
                key={b.id} role="radio" aria-checked={settings.backdrop === b.id}
                className={`backdrop backdrop-${b.id} ${settings.backdrop === b.id ? 'on' : ''}`}
                style={b.id === 'color' ? { background: settings.color } : undefined}
                onClick={() => updateBackground({ backdrop: b.id })}
              >
                <span>{t(b.label)}</span>
              </button>
            ))}
            {settings.backdrop === 'color' && (
              <label className="backdrop-color">
                <input type="color" value={settings.color} aria-label={t('media.background.pickColor')}
                  onChange={(e) => updateBackground({ color: e.target.value })} />
                {t('media.background.pickColor')}
              </label>
            )}
          </div>
        )}
        {!supported && <p className="muted">{t('media.background.unsupported')}</p>}
        {supported && slow && settings.mode !== 'off' && <p className="audio-warning" role="note">{t('media.background.slow')}</p>}
        {inCall && cameraOn && stats && (
          <p className="muted" role="status">{t('media.background.running', { fps: Math.round(stats.outputFps), ms: stats.frameMs.toFixed(1) })}</p>
        )}
      </section>
    </>
  )
}
