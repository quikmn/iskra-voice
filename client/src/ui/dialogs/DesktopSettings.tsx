// Settings → Desktop app (only in the desktop app): start with the computer, close to tray, hardware acceleration.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop, type DesktopSettings } from '../../platform/desktop'

export function DesktopSettingsSection() {
  const { t } = useTranslation()
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
      <h2>{t('settings.sections.desktop')}</h2>
      <label className="checkbox">
        <input type="checkbox" checked={settings.openAtLogin} onChange={(e) => void update({ openAtLogin: e.target.checked })} />
        <span>
          {t('settings.desktop.openAtLogin')}
          <br /><small className="muted">{t('settings.desktop.openAtLoginHint')}</small>
        </span>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={settings.closeToTray} onChange={(e) => void update({ closeToTray: e.target.checked })} />
        <span>
          {t('settings.desktop.closeToTray')}
          <br /><small className="muted">{t('settings.desktop.closeToTrayHint')}</small>
        </span>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={settings.hardwareAcceleration} onChange={(e) => void update({ hardwareAcceleration: e.target.checked })} />
        <span>
          {t('settings.desktop.hardware')}
          <br /><small className="muted">{t('settings.desktop.hardwareHint')}</small>
        </span>
      </label>
      {restartNeeded && (
        <div className="copy-row" role="status">
          <span className="muted">{t('settings.desktop.restartHint')}</span>
          <button className="button primary" onClick={() => void desktop!.settings.relaunch()}>{t('settings.desktop.restart')}</button>
        </div>
      )}
    </section>
    <ActivitySettings settings={settings} update={update} />
    </>
  )
}

/** Activity status: opt-in game detection, plus your own programs. */
function ActivitySettings({ settings, update }: { settings: DesktopSettings; update: (patch: Partial<DesktopSettings>) => Promise<void> }) {
  const { t } = useTranslation()
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
      <h2>{t('settings.desktop.activityTitle')}</h2>
      <label className="checkbox">
        <input type="checkbox" checked={settings.activity} onChange={(e) => void update({ activity: e.target.checked })} />
        <span>
          {t('settings.desktop.activity')}
          <br /><small className="muted">{t('settings.desktop.activityHint')}</small>
        </span>
      </label>
      {settings.activity && <p className="muted" role="status">{game ? t('settings.desktop.nowPlaying', { game }) : t('settings.desktop.noGame')}</p>}
      <p className="muted">{t('settings.desktop.addGameHint')}</p>
      {settings.customGames.length > 0 && (
        <ul className="custom-games">
          {settings.customGames.map((g, i) => (
            <li key={`${g.process}-${i}`}>
              <span><strong>{g.name}</strong> · <code>{g.process}</code></span>
              <button className="button small" onClick={() => void update({ customGames: settings.customGames.filter((_, j) => j !== i) })}>{t('common.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      <form className="custom-game-add" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input aria-label={t('settings.desktop.gameName')} placeholder={t('settings.desktop.gameName')} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label={t('settings.desktop.programFile')} placeholder={t('common.example', { value: 'mygame.exe' })} maxLength={100} value={program} onChange={(e) => setProgram(e.target.value)} />
        <button className="button" disabled={!name.trim() || !program.trim() || settings.customGames.length >= 30}>{t('common.add')}</button>
      </form>
    </section>
  )
}
