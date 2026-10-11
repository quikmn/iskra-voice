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
    <>
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
    <ActivitySettings settings={settings} update={update} />
    </>
  )
}

/** Activity status: opt-in game detection, plus your own programs. */
function ActivitySettings({ settings, update }: { settings: DesktopSettings; update: (patch: Partial<DesktopSettings>) => Promise<void> }) {
  const [game, setGame] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [program, setProgram] = useState('')
  useEffect(() => {
    if (!desktop) return
    void desktop.activity().then(setGame, () => undefined)
    return desktop.onActivity(setGame)
  }, [])
  const add = () => {
    if (!name.trim() || !program.trim()) return
    void update({ customGames: [...settings.customGames, { name: name.trim(), process: program.trim() }] })
    setName('')
    setProgram('')
  }

  return (
    <section className="settings-section">
      <h3>Activity status</h3>
      <label className="checkbox">
        <input type="checkbox" checked={settings.activity} onChange={(e) => void update({ activity: e.target.checked })} />
        <span>
          Show the game you're playing
          <br /><small className="muted">
            Iskra checks running program names against a list of games every 30 seconds, on this computer. Only the game's name is
            shared, as "Playing …" on your profile. Never window titles or your other programs.
          </small>
        </span>
      </label>
      {settings.activity && <p className="muted" role="status">{game ? `Now: Playing ${game}` : 'No game detected right now.'}</p>}
      <p className="muted">Add a game that isn't recognised: its name, and its program file (as in Task Manager, e.g. mygame.exe).</p>
      {settings.customGames.length > 0 && (
        <ul className="custom-games">
          {settings.customGames.map((g, i) => (
            <li key={`${g.process}-${i}`}>
              <span><strong>{g.name}</strong> · <code>{g.process}</code></span>
              <button className="button small" onClick={() => void update({ customGames: settings.customGames.filter((_, j) => j !== i) })}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className="custom-game-add" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input aria-label="Game name" placeholder="Game name" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Program file" placeholder="mygame.exe" maxLength={100} value={program} onChange={(e) => setProgram(e.target.value)} />
        <button className="button" disabled={!name.trim() || !program.trim() || settings.customGames.length >= 30}>Add</button>
      </form>
    </section>
  )
}
