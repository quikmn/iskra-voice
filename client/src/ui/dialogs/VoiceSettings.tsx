import { useState } from 'react'
import { desktop } from '../../platform/desktop'
import { updateVoiceSettings, useVoice } from '../../state/voice'

/** Voice activity vs push-to-talk, and the key. Global key on desktop, in-page key on the web. */
export function VoiceSettingsSection() {
  const settings = useVoice((s) => s.settings)
  const pttDown = useVoice((s) => s.pttDown)
  const [capturing, setCapturing] = useState(false)
  const key = desktop ? settings.desktopKey : settings.webKey

  async function captureKey() {
    setCapturing(true)
    if (desktop) {
      const { code, name } = await desktop.capturePushToTalkKey()
      updateVoiceSettings({ desktopKey: { code, label: name } })
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
      <h3>Voice</h3>
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
          <p className="muted">
            {desktop
              ? 'Works everywhere, even while a game has focus. Mouse side buttons work too.'
              : "In the browser, push to talk only works while this tab is focused. The desktop app works everywhere."}
          </p>
        </>
      )}
    </section>
  )
}
