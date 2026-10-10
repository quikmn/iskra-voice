// Settings → Desktop app (only in the desktop app): start with the computer, close to tray, hardware acceleration.
import { useEffect, useState } from 'react'
import { desktop, type DesktopSettings } from '../../platform/desktop'

export function DesktopSettingsSection() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  // Hardware acceleration as it was when the app started (it changes only after a restart).
  const [startedWith, setStartedWith] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void desktop?.settings.get().then((s) => {
      if (!alive || !s) return
      setSettings(s)
      setStartedWith((v) => v ?? s.hardwareAcceleration)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!desktop || !settings) return null
  const update = async (patch: Partial<DesktopSettings>) => {
    setSettings({ ...settings, ...patch }) // the app confirms right after
    setSettings(await desktop!.settings.set(patch))
  }
  const restartNeeded = startedWith !== null && startedWith !== settings.hardwareAcceleration

  return (
    <section className="settings-section">
      <h3>Desktop app</h3>
      <label className="checkbox">
        <input type="checkbox" checked={settings.openAtLogin} onChange={(e) => void update({ openAtLogin: e.target.checked })} />
        <span>
          Start Iskra with your computer
          <br /><small className="muted">It starts in the tray, ready for calls and messages.</small>
        </span>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={settings.closeToTray} onChange={(e) => void update({ closeToTray: e.target.checked })} />
        <span>
          Close button minimises to the tray
          <br /><small className="muted">Otherwise closing the window quits Iskra.</small>
        </span>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={settings.hardwareAcceleration} onChange={(e) => void update({ hardwareAcceleration: e.target.checked })} />
        <span>
          Hardware acceleration
          <br /><small className="muted">Uses your graphics card for video and screen sharing. Turn it off if the window flickers or stays black.</small>
        </span>
      </label>
      {restartNeeded && (
        <div className="copy-row" role="status">
          <span className="muted">Restart Iskra to apply this.</span>
          <button className="button primary" onClick={() => void desktop!.settings.relaunch()}>Restart now</button>
        </div>
      )}
    </section>
  )
}
