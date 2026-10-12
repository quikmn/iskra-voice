// Settings → Voice & audio: devices, mic test with a live meter, sensitivity, noise suppression, hi-fi, output,
// incoming voices (leveling, clean-up) and sounds.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t as translate } from '../../i18n'
import {
  agcOn, AUTO_SPEAKING_DB, canBoost, captureOptions, MIN_THRESHOLD, meterFraction, outputSelectable, updateAudio, useAudio,
  type AiStrength, type NoiseMode,
} from '../../state/audio'
import { engineCaps, engineHealth, fallbackReason, plannedEngine, retryAi, type NoiseEngine } from '../../state/audio/engines'
import { createMicPipeline, type MicPipeline } from '../../state/micPipeline'
import { maxVolume, micPipelineActive, onMicLevel, useVoice } from '../../state/voice'
import { playTone } from '../../state/notify'
import '../audio.css'

// ── Devices ──────────────────────────────────────────────────────────────

function useDevices(refresh: unknown) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const media = navigator.mediaDevices
    if (!media?.enumerateDevices) return
    let alive = true
    const load = () => void media.enumerateDevices().then((d) => alive && setDevices(d), () => undefined)
    load()
    media.addEventListener?.('devicechange', load)
    return () => {
      alive = false
      media.removeEventListener?.('devicechange', load)
    }
  }, [refresh])
  return devices
}

function DevicePicker({ label, kind, value, devices, onChange }: {
  label: string; kind: MediaDeviceKind; value: string; devices: MediaDeviceInfo[]; onChange: (id: string) => void
}) {
  const { t } = useTranslation()
  const list = devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
  const unnamed = list.length > 0 && list.every((d) => !d.label)
  const known = !value || list.some((d) => d.deviceId === value)
  return (
    <label className="field">
      <span>{label}</span>
      <select value={known ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('settings.audio.systemDefault')}</option>
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>{d.label || t(kind === 'audioinput' ? 'settings.audio.micN' : 'settings.audio.speakerN', { n: i + 1 })}</option>
        ))}
      </select>
      {unnamed && kind === 'audioinput' && <small className="muted">{t('settings.audio.testForNames')}</small>}
    </label>
  )
}

// ── Mic test ─────────────────────────────────────────────────────────────

/** Your live mic level: from the call if you're in one, otherwise from a test capture while `testing`. */
function useMicLevel(testing: boolean, hearSelf: boolean, onMeter: (db: number, open: boolean) => void, onError: (message: string | null) => void) {
  const settings = useAudio()
  const ptt = useVoice((s) => s.settings.mode === 'ptt')
  const inCall = useVoice((s) => !!s.session?.canSpeak && s.session.state === 'connected')
  // micEngine is set once the call's mic path is up (null without one).
  const pipelineUp = useVoice((s) => s.micEngine !== null)
  const fromCall = inCall && pipelineUp && micPipelineActive()
  const pipeline = useRef<MicPipeline | null>(null)
  const meter = useRef(onMeter)
  useEffect(() => {
    meter.current = onMeter
  })

  useEffect(() => {
    if (!fromCall) return
    return onMicLevel((db, open) => meter.current(db, open))
  }, [fromCall])

  // A new capture when the device or the processing changes; volume and threshold apply live.
  const { inputDevice, noise, echoCancellation, autoGainControl } = settings
  useEffect(() => {
    if (!testing || fromCall) return
    let alive = true
    let stream: MediaStream | null = null
    let player: HTMLAudioElement | null = null
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error(translate('settings.audio.noMicApi'))
        const s = useAudio.getState()
        const options = captureOptions(s, plannedEngine(s.noise))
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: options })
        } catch (e) {
          if (!options.deviceId) throw e
          stream = await navigator.mediaDevices.getUserMedia({ audio: { ...options, deviceId: undefined } })
        }
        if (!alive) return
        const next = await createMicPipeline(stream.getAudioTracks()[0], s, useVoice.getState().settings.mode === 'ptt', {
          onLevel: (db, open) => meter.current(db, open),
        })
        if (!alive) return next?.destroy()
        pipeline.current = next
        onError(next ? null : translate('settings.audio.noMeter'))
        if (hearSelf) {
          player = new Audio()
          player.srcObject = new MediaStream([next?.track ?? stream.getAudioTracks()[0]])
          const sink = s.outputDevice
          if (sink && 'setSinkId' in player) await player.setSinkId(sink).catch(() => undefined)
          void player.play().catch(() => undefined)
        }
      } catch (e) {
        const name = (e as Error).name
        onError(name === 'NotAllowedError' ? translate('settings.audio.notAllowed') : name === 'NotFoundError' ? translate('settings.audio.notFound') : translate('settings.audio.cantOpen'))
      }
    })()
    return () => {
      alive = false
      pipeline.current?.destroy()
      pipeline.current = null
      player?.pause()
      if (player) player.srcObject = null
      stream?.getTracks().forEach((t) => t.stop())
      meter.current(-160, false)
    }
  }, [testing, fromCall, hearSelf, inputDevice, noise, echoCancellation, autoGainControl, onError])

  useEffect(() => {
    pipeline.current?.update(settings, ptt)
  }, [settings, ptt])

  return { fromCall }
}

/**
 * Level bar. Automatic: it lights up when voice activity detection hears you. Manual: the threshold is marked on
 * it and the slider sets it.
 */
function LevelMeter({ testing, hearSelf, onError }: { testing: boolean; hearSelf: boolean; onError: (m: string | null) => void }) {
  const { t } = useTranslation()
  const threshold = useAudio((s) => s.threshold)
  const fill = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const shownThreshold = threshold ?? AUTO_SPEAKING_DB
  const thresholdRef = useRef(shownThreshold)
  useEffect(() => {
    thresholdRef.current = shownThreshold
  }, [shownThreshold])
  const manual = threshold !== null
  const { fromCall } = useMicLevel(testing, hearSelf, (db, gateOpen) => {
    if (fill.current) fill.current.style.transform = `scaleX(${meterFraction(db)})`
    const above = manual ? db >= thresholdRef.current : gateOpen && db > -160
    setOpen((o) => (o === above ? o : above))
  }, onError)

  return (
    <div className="mic-meter-wrap">
      <div className={`mic-meter ${open ? 'open' : ''}`} role="presentation">
        <div ref={fill} className="mic-meter-fill" />
        {manual && <div className="mic-meter-mark" style={{ left: `${meterFraction(shownThreshold) * 100}%` }} />}
      </div>
      {threshold !== null && (
        <input
          className="mic-threshold" type="range" min={MIN_THRESHOLD} max={0} step={1} value={threshold}
          aria-label={t('settings.audio.sensitivity')} aria-valuetext={`${threshold} dB`}
          onChange={(e) => updateAudio({ threshold: Number(e.target.value) })}
        />
      )}
      {fromCall && <small className="muted">{t('settings.audio.fromCall')}</small>}
    </div>
  )
}

// ── Sections ─────────────────────────────────────────────────────────────

/** Microphone: device, volume, test and sensitivity. Sits above the voice activity / push-to-talk choice. */
export function InputSettingsSection() {
  const { t } = useTranslation()
  const settings = useAudio()
  const inCall = useVoice((s) => !!s.session?.canSpeak && s.session.state === 'connected')
  const [testing, setTesting] = useState(false)
  const [hearSelf, setHearSelf] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const devices = useDevices(testing || inCall)

  return (
    <section className="settings-section audio-settings">
      <h3>{t('settings.audio.microphone')}</h3>
      <DevicePicker label={t('settings.audio.inputDevice')} kind="audioinput" value={settings.inputDevice} devices={devices} onChange={(id) => updateAudio({ inputDevice: id })} />
      <label className="field">
        <span>{t('settings.audio.inputVolumeValue', { percent: Math.round(settings.inputVolume * 100) })}</span>
        <input type="range" min={0} max={2} step={0.05} value={settings.inputVolume} aria-label={t('settings.audio.inputVolume')}
          onChange={(e) => updateAudio({ inputVolume: Number(e.target.value) })} />
      </label>

      <div className="field">
        <span>{t('settings.audio.sensitivity')}</span>
        <label className="checkbox">
          <input type="checkbox" checked={settings.threshold === null}
            onChange={(e) => updateAudio({ threshold: e.target.checked ? null : AUTO_SPEAKING_DB })} />
          {t('settings.audio.auto')}
        </label>
        <LevelMeter testing={testing} hearSelf={hearSelf} onError={setError} />
        <small className="muted">
          {settings.threshold === null ? t('settings.audio.autoHint') : t('settings.audio.manualHint')}
        </small>
      </div>

      {!inCall && (
        <div className="copy-row mic-test-row">
          <button className={`button ${testing ? '' : 'primary'}`} onClick={() => setTesting(!testing)} aria-pressed={testing}>
            {testing ? t('settings.audio.stopTest') : t('settings.audio.test')}
          </button>
          <label className="checkbox">
            <input type="checkbox" checked={hearSelf} onChange={(e) => setHearSelf(e.target.checked)} />
            {t('settings.audio.hearSelf')}
          </label>
        </div>
      )}
      {error && testing && <p className="muted" role="status">{error}</p>}
    </section>
  )
}

const NOISE: { id: NoiseMode; label: 'common.off' | 'settings.audio.standard' | 'settings.audio.strong' | 'settings.audio.ai' }[] = [
  { id: 'off', label: 'common.off' },
  { id: 'standard', label: 'settings.audio.standard' },
  { id: 'strong', label: 'settings.audio.strong' },
  { id: 'ai', label: 'settings.audio.ai' },
]

const AI_STRENGTH: { id: AiStrength; label: 'settings.audio.aiGentle' | 'settings.audio.aiNormal' | 'settings.audio.aiMax' }[] = [
  { id: 'gentle', label: 'settings.audio.aiGentle' },
  { id: 'normal', label: 'settings.audio.aiNormal' },
  { id: 'max', label: 'settings.audio.aiMax' },
]

const ENGINE: Record<NoiseEngine, 'settings.audio.engineAi' | 'settings.audio.engineRnnoise' | 'settings.audio.engineBrowser' | 'settings.audio.engineOff'> = {
  ai: 'settings.audio.engineAi',
  rnnoise: 'settings.audio.engineRnnoise',
  browser: 'settings.audio.engineBrowser',
  off: 'settings.audio.engineOff',
}

/** Which engine is cleaning up your mic (in the call, or what would run), why it isn't the one you chose, and its CPU. */
function EngineStatus() {
  const { t } = useTranslation()
  const noise = useAudio((s) => s.noise)
  const inCall = useVoice((s) => s.session?.state === 'connected' && s.session.canSpeak)
  const callEngine = useVoice((s) => s.micEngine)
  const hifi = useVoice((s) => s.hifi)
  const load = useVoice((s) => s.aiLoad)
  if (inCall && hifi) return <p className="muted engine-status" role="status">{t('settings.audio.hifiActive')}</p>
  const engine = inCall && callEngine ? callEngine : plannedEngine(noise)
  const reason = fallbackReason(noise, engineCaps(), engineHealth())
  return (
    <p className="muted engine-status" role="status" data-engine={engine}>
      <strong>{t('settings.audio.engineActive', { engine: t(ENGINE[engine]) })}</strong>
      {reason === 'slow' && ` ${t('settings.audio.aiSlow')}`}
      {reason === 'unsupported' && noise === 'ai' && ` ${t('settings.audio.aiUnsupported')}`}
      {reason === 'unsupported' && noise === 'strong' && ` ${t('settings.audio.strongUnsupported')}`}
      {reason === 'failed' && ` ${t(noise === 'ai' ? 'settings.audio.aiFailed' : 'settings.audio.strongFailed')}`}
      {inCall && engine === 'ai' && load !== null && ` ${t('settings.audio.aiLoad', { percent: Math.max(1, Math.round(load * 100)) })}`}
    </p>
  )
}

/** Noise suppression, echo cancellation, automatic gain and hi-fi. */
export function ProcessingSettingsSection() {
  const { t } = useTranslation()
  const settings = useAudio()
  const caps = engineCaps()
  const mode = settings.noise

  return (
    <section className="settings-section audio-settings">
      <h3>{t('settings.audio.noise')}</h3>
      <div className="segmented" role="radiogroup" aria-label={t('settings.audio.noise')}>
        {NOISE.map((n) => (
          <button
            key={n.id} role="radio" aria-checked={mode === n.id} className={mode === n.id ? 'on' : ''}
            disabled={(n.id === 'strong' || n.id === 'ai') && !caps.worklet}
            onClick={() => {
              if (n.id === 'ai') retryAi() // choosing it again gives it another try
              updateAudio({ noise: n.id })
            }}
          >
            {t(n.label)}
          </button>
        ))}
      </div>
      <p className="muted">
        {mode === 'ai' ? t('settings.audio.aiHint') : mode === 'strong' ? t('settings.audio.strongHint') : mode === 'standard' ? t('settings.audio.standardHint') : t('settings.audio.offHint')}
      </p>
      <EngineStatus />
      {mode === 'ai' && (
        <>
          <h3 id="ai-strength">{t('settings.audio.aiStrength')}</h3>
          <div className="segmented" role="radiogroup" aria-labelledby="ai-strength">
            {AI_STRENGTH.map((n) => (
              <button
                key={n.id} role="radio" aria-checked={settings.aiStrength === n.id} className={settings.aiStrength === n.id ? 'on' : ''}
                onClick={() => updateAudio({ aiStrength: n.id })}
              >
                {t(n.label)}
              </button>
            ))}
          </div>
          <p className="muted">{t('settings.audio.aiStrengthHint')}</p>
        </>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={settings.echoCancellation} onChange={(e) => updateAudio({ echoCancellation: e.target.checked })} />
        {t('settings.audio.echo')}
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={agcOn(settings, plannedEngine(mode))} onChange={(e) => updateAudio({ autoGainControl: e.target.checked })} />
        {t('settings.audio.agc')}
      </label>
      <p className="muted">{t('settings.audio.agcHint')}</p>
      <label className="checkbox">
        <input type="checkbox" checked={settings.hifi} onChange={(e) => updateAudio({ hifi: e.target.checked })} />
        {t('settings.audio.hifi')}
      </label>
      <p className="muted">{t('settings.audio.hifiHint')}</p>
      {settings.hifi && <p className="audio-warning" role="note">{t('settings.audio.headphones')}</p>}
    </section>
  )
}

/** Incoming voices: leveling and clean-up, where the app mixes with Web Audio. */
function IncomingSettings() {
  const { t } = useTranslation()
  const settings = useAudio()
  const inCall = useVoice((s) => s.session?.state === 'connected')
  const processing = useVoice((s) => s.processingIncoming)
  const cleaning = useVoice((s) => s.cleanEngine)
  const available = engineCaps().worklet && canBoost()
  return (
    <>
      <label className="checkbox">
        <input type="checkbox" checked={settings.leveling} disabled={!available} onChange={(e) => updateAudio({ leveling: e.target.checked })} />
        {t('settings.audio.leveling')}
      </label>
      <p className="muted">{t('settings.audio.levelingHint')}</p>
      <label className="checkbox">
        <input type="checkbox" checked={settings.cleanIncoming} disabled={!available} onChange={(e) => updateAudio({ cleanIncoming: e.target.checked })} />
        {t('settings.audio.cleanIncoming')}
      </label>
      <p className="muted">
        {t('settings.audio.cleanIncomingHint')}
        {inCall && processing && settings.cleanIncoming && cleaning && ` ${t('settings.audio.cleaningWith', { engine: t(ENGINE[cleaning === 'ai' ? 'ai' : 'rnnoise']) })}`}
      </p>
      {!available && <p className="muted">{t('settings.audio.incomingUnsupported')}</p>}
    </>
  )
}

/** Speakers, output volume, per-person volume hint and voice sounds. */
export function OutputSettingsSection() {
  const { t } = useTranslation()
  const settings = useAudio()
  const devices = useDevices(null)
  const max = maxVolume()
  return (
    <section className="settings-section audio-settings">
      <h3>{t('settings.audio.sound')}</h3>
      {outputSelectable() && (
        <DevicePicker label={t('settings.audio.outputDevice')} kind="audiooutput" value={settings.outputDevice} devices={devices} onChange={(id) => updateAudio({ outputDevice: id })} />
      )}
      <label className="field">
        <span>{t('settings.audio.outputVolumeValue', { percent: Math.round(Math.min(settings.outputVolume, max) * 100) })}</span>
        <input type="range" min={0} max={max} step={0.05} value={Math.min(settings.outputVolume, max)} aria-label={t('settings.audio.outputVolume')}
          onChange={(e) => updateAudio({ outputVolume: Number(e.target.value) })} />
      </label>
      <p className="muted">{t('settings.audio.perPerson')}</p>
      <IncomingSettings />
      <label className="checkbox">
        <input type="checkbox" checked={settings.voiceSounds} onChange={(e) => {
          updateAudio({ voiceSounds: e.target.checked })
          if (e.target.checked) playTone('join')
        }} />
        {t('settings.audio.voiceSounds')}
      </label>
    </section>
  )
}
