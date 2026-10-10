// Settings → Voice & audio: devices, mic test with a live meter, sensitivity, noise suppression, output and sounds.
import { useEffect, useRef, useState } from 'react'
import {
  AUTO_SPEAKING_DB, captureOptions, MIN_THRESHOLD, meterFraction, outputSelectable, strongSupported, updateAudio, useAudio,
  type NoiseMode,
} from '../../state/audio'
import { createMicPipeline, strongWorks, type MicPipeline } from '../../state/micPipeline'
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
  const list = devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
  const unnamed = list.length > 0 && list.every((d) => !d.label)
  const known = !value || list.some((d) => d.deviceId === value)
  return (
    <label className="field">
      <span>{label}</span>
      <select value={known ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">System default</option>
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>{d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${i + 1}`}</option>
        ))}
      </select>
      {unnamed && kind === 'audioinput' && <small className="muted">Test your mic once to see the device names.</small>}
    </label>
  )
}

// ── Mic test ─────────────────────────────────────────────────────────────

/** Your live mic level: from the call if you're in one, otherwise from a test capture while `testing`. */
function useMicLevel(testing: boolean, hearSelf: boolean, onMeter: (db: number) => void, onError: (message: string | null) => void) {
  const settings = useAudio()
  const inCall = useVoice((s) => !!s.session?.canSpeak && s.session.state === 'connected')
  // strongActive is set once the call's mic path is up (null without one).
  const pipelineUp = useVoice((s) => s.strongActive !== null)
  const fromCall = inCall && pipelineUp && micPipelineActive()
  const pipeline = useRef<MicPipeline | null>(null)
  const meter = useRef(onMeter)
  useEffect(() => {
    meter.current = onMeter
  })

  useEffect(() => {
    if (!fromCall) return
    return onMicLevel((db) => meter.current(db))
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
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use a microphone here.")
        const s = useAudio.getState()
        const options = captureOptions(s, strongWorks())
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: options })
        } catch (e) {
          if (!options.deviceId) throw e
          stream = await navigator.mediaDevices.getUserMedia({ audio: { ...options, deviceId: undefined } })
        }
        if (!alive) return
        const next = await createMicPipeline(stream.getAudioTracks()[0], s, (db) => meter.current(db))
        if (!alive) return next?.destroy()
        pipeline.current = next
        onError(next ? null : "The level meter doesn't work in this browser, but your mic does.")
        if (hearSelf) {
          player = new Audio()
          player.srcObject = new MediaStream([next?.track ?? stream.getAudioTracks()[0]])
          const sink = s.outputDevice
          if (sink && 'setSinkId' in player) await player.setSinkId(sink).catch(() => undefined)
          void player.play().catch(() => undefined)
        }
      } catch (e) {
        const name = (e as Error).name
        onError(name === 'NotAllowedError' ? "Iskra isn't allowed to use your microphone. Check your browser's permissions." : name === 'NotFoundError' ? 'No microphone found.' : "Couldn't open your microphone.")
      }
    })()
    return () => {
      alive = false
      pipeline.current?.destroy()
      pipeline.current = null
      player?.pause()
      if (player) player.srcObject = null
      stream?.getTracks().forEach((t) => t.stop())
      meter.current(-160)
    }
  }, [testing, fromCall, hearSelf, inputDevice, noise, echoCancellation, autoGainControl, onError])

  useEffect(() => {
    pipeline.current?.update(settings)
  }, [settings])

  return { fromCall }
}

/** Level bar with the threshold marked on it; in manual mode the slider sets the threshold. */
function LevelMeter({ testing, hearSelf, onError }: { testing: boolean; hearSelf: boolean; onError: (m: string | null) => void }) {
  const threshold = useAudio((s) => s.threshold)
  const fill = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const shownThreshold = threshold ?? AUTO_SPEAKING_DB
  const thresholdRef = useRef(shownThreshold)
  useEffect(() => {
    thresholdRef.current = shownThreshold
  }, [shownThreshold])
  const { fromCall } = useMicLevel(testing, hearSelf, (db) => {
    if (fill.current) fill.current.style.transform = `scaleX(${meterFraction(db)})`
    const above = db >= thresholdRef.current
    setOpen((o) => (o === above ? o : above))
  }, onError)

  return (
    <div className="mic-meter-wrap">
      <div className={`mic-meter ${open ? 'open' : ''}`} role="presentation">
        <div ref={fill} className="mic-meter-fill" />
        <div className="mic-meter-mark" style={{ left: `${meterFraction(shownThreshold) * 100}%` }} />
      </div>
      {threshold !== null && (
        <input
          className="mic-threshold" type="range" min={MIN_THRESHOLD} max={0} step={1} value={threshold}
          aria-label="Input sensitivity" aria-valuetext={`${threshold} dB`}
          onChange={(e) => updateAudio({ threshold: Number(e.target.value) })}
        />
      )}
      {fromCall && <small className="muted">Showing your mic in the call.</small>}
    </div>
  )
}

// ── Sections ─────────────────────────────────────────────────────────────

/** Microphone: device, volume, test and sensitivity. Sits above the voice activity / push-to-talk choice. */
export function InputSettingsSection() {
  const settings = useAudio()
  const inCall = useVoice((s) => !!s.session?.canSpeak && s.session.state === 'connected')
  const [testing, setTesting] = useState(false)
  const [hearSelf, setHearSelf] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const devices = useDevices(testing || inCall)

  return (
    <section className="settings-section audio-settings">
      <h3>Microphone</h3>
      <DevicePicker label="Input device" kind="audioinput" value={settings.inputDevice} devices={devices} onChange={(id) => updateAudio({ inputDevice: id })} />
      <label className="field">
        <span>Input volume · {Math.round(settings.inputVolume * 100)}%</span>
        <input type="range" min={0} max={2} step={0.05} value={settings.inputVolume} aria-label="Input volume"
          onChange={(e) => updateAudio({ inputVolume: Number(e.target.value) })} />
      </label>

      <div className="field">
        <span>Input sensitivity</span>
        <label className="checkbox">
          <input type="checkbox" checked={settings.threshold === null}
            onChange={(e) => updateAudio({ threshold: e.target.checked ? null : AUTO_SPEAKING_DB })} />
          Set automatically
        </label>
        <LevelMeter testing={testing} hearSelf={hearSelf} onError={setError} />
        <small className="muted">
          {settings.threshold === null
            ? 'Your mic opens when you speak. Turn this off to choose how loud you have to be.'
            : 'Your mic only sends sound above the marker. Drag it just above your background noise.'}
        </small>
      </div>

      {!inCall && (
        <div className="copy-row mic-test-row">
          <button className={`button ${testing ? '' : 'primary'}`} onClick={() => setTesting(!testing)} aria-pressed={testing}>
            {testing ? 'Stop test' : 'Test microphone'}
          </button>
          <label className="checkbox">
            <input type="checkbox" checked={hearSelf} onChange={(e) => setHearSelf(e.target.checked)} />
            Let me hear myself
          </label>
        </div>
      )}
      {error && testing && <p className="muted" role="status">{error}</p>}
    </section>
  )
}

const NOISE: { id: NoiseMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'standard', label: 'Standard' },
  { id: 'strong', label: 'Strong' },
]

/** Noise suppression, echo cancellation and automatic gain. */
export function ProcessingSettingsSection() {
  const settings = useAudio()
  const strongActive = useVoice((s) => s.strongActive)
  const supported = strongSupported()
  const mode = settings.noise === 'strong' && !supported ? 'standard' : settings.noise

  return (
    <section className="settings-section audio-settings">
      <h3>Noise suppression</h3>
      <div className="segmented" role="radiogroup" aria-label="Noise suppression">
        {NOISE.map((n) => (
          <button
            key={n.id} role="radio" aria-checked={mode === n.id} className={mode === n.id ? 'on' : ''}
            disabled={n.id === 'strong' && !supported}
            onClick={() => updateAudio({ noise: n.id })}
          >
            {n.label}
          </button>
        ))}
      </div>
      <p className="muted">
        {mode === 'strong'
          ? 'Removes keyboards, fans and background chatter with RNNoise, right here on your device.'
          : mode === 'standard' ? "Your browser's built-in noise suppression." : 'Sends your mic as it is.'}
        {!supported && ' Strong noise suppression needs a newer browser.'}
        {supported && mode === 'strong' && strongActive === false && " It couldn't start on this device, so the browser's is used for this call."}
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={settings.echoCancellation} onChange={(e) => updateAudio({ echoCancellation: e.target.checked })} />
        Echo cancellation
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={settings.autoGainControl} onChange={(e) => updateAudio({ autoGainControl: e.target.checked })} />
        Automatic gain control
      </label>
    </section>
  )
}

/** Speakers, output volume, per-person volume hint and voice sounds. */
export function OutputSettingsSection() {
  const settings = useAudio()
  const devices = useDevices(null)
  const max = maxVolume()
  return (
    <section className="settings-section audio-settings">
      <h3>Sound</h3>
      {outputSelectable() && (
        <DevicePicker label="Output device" kind="audiooutput" value={settings.outputDevice} devices={devices} onChange={(id) => updateAudio({ outputDevice: id })} />
      )}
      <label className="field">
        <span>Output volume · {Math.round(Math.min(settings.outputVolume, max) * 100)}%</span>
        <input type="range" min={0} max={max} step={0.05} value={Math.min(settings.outputVolume, max)} aria-label="Output volume"
          onChange={(e) => updateAudio({ outputVolume: Number(e.target.value) })} />
      </label>
      <p className="muted">To change one person's volume, right-click them in a voice channel, or press and hold on a phone.</p>
      <label className="checkbox">
        <input type="checkbox" checked={settings.voiceSounds} onChange={(e) => {
          updateAudio({ voiceSounds: e.target.checked })
          if (e.target.checked) playTone('join')
        }} />
        Join, leave, mute and deafen sounds
      </label>
    </section>
  )
}
