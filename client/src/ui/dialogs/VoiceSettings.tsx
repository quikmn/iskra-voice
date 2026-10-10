import { useEffect, useState } from 'react'
import { desktop, type PushToTalkStatus } from '../../platform/desktop'
import { updateVoiceSettings, useVoice } from '../../state/voice'

/** Voice activity vs push-to-talk, and the key. Global key on desktop, in-page key on the web. */
export function VoiceSettingsSection() {
  const settings = useVoice((s) => s.settings)
  const pttDown = useVoice((s) => s.pttDown)
  const [capturing, setCapturing] = useState(false)
  const key = desktop ? settings.desktopKey : settings.webKey
  const pttStatus = usePushToTalkStatus(settings.mode === 'ptt')

  async function captureKey() {
    setCapturing(true)
    if (desktop) {
      const captured = await desktop.capturePushToTalkKey()
      if (captured) updateVoiceSettings({ desktopKey: { code: captured.code, label: captured.name } })
    } else {
      const code = await new Promise<{ code: string; label: string }>((resolve) => {
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault()
          window.removeEventListener('keydown', onKey, true)
          resolve({ code: e.code, label: e.key.length === 1 ? e.key.toUpperCase() : e.code })
        }
        window.addEventListener('keydown', onKey, true)
      })
      updateVoiceSettings({ webKey: code })
    }
    setCapturing(false)
  }

  return (
    <section className="settings-section">
      <h3>Input mode</h3>
      <div className="segmented" role="radiogroup" aria-label="Input mode">
        <button role="radio" aria-checked={settings.mode === 'voice'} className={settings.mode === 'voice' ? 'on' : ''} onClick={() => updateVoiceSettings({ mode: 'voice' })}>
          Voice activity
        </button>
        <button role="radio" aria-checked={settings.mode === 'ptt'} className={settings.mode === 'ptt' ? 'on' : ''} onClick={() => updateVoiceSettings({ mode: 'ptt' })}>
          Push to talk
        </button>
      </div>
      {settings.mode === 'ptt' && (
        <>
          <div className="copy-row">
            <span className={`key-chip ${pttDown ? 'down' : ''}`}>{capturing ? 'Press a key…' : (key?.label ?? 'No key set')}</span>
            <button className="button" onClick={() => void captureKey()} disabled={capturing}>
              {key ? 'Change key' : 'Set key'}
            </button>
          </div>
          {desktop ? (
            <PushToTalkHint status={pttStatus} />
          ) : (
            <p className="muted">In the browser, push to talk only works while this tab is focused. The desktop app works everywhere.</p>
          )}
        </>
      )}
    </section>
  )
}

/** Desktop: whether the global key hook works here. Re-checked while open, so granting a permission shows up right away. */
function usePushToTalkStatus(active: boolean): PushToTalkStatus {
  const [status, setStatus] = useState<PushToTalkStatus>('ready')
  useEffect(() => {
    if (!desktop || !active) return
    let alive = true
    const check = () => void desktop!.pushToTalkStatus().then((s) => alive && setStatus(s), () => undefined)
    check()
    const timer = setInterval(check, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [active])
  return status
}

function PushToTalkHint({ status }: { status: PushToTalkStatus }) {
  if (status === 'needs-permission') {
    return (
      <div>
        <p className="muted">
          To notice your key while you're in another app, macOS needs you to allow Iskra under Privacy &amp; Security → Accessibility.
        </p>
        <button className="button" onClick={() => void desktop?.openSystemSettings('accessibility')}>Open System Settings</button>
      </div>
    )
  }
  if (status === 'limited') {
    return (
      <p className="muted">
        On Wayland, Iskra only sees your key while Iskra or an X11 app has focus. For a key that works everywhere, use an X11 session, or voice activity.
      </p>
    )
  }
  if (status === 'unavailable') return <p className="muted">Push to talk couldn't start on this computer. Voice activity works everywhere.</p>
  return <p className="muted">Works everywhere, even while a game has focus. Mouse side buttons work too.</p>
}
