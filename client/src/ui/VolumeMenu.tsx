// One person's volume in voice, as the people menu shows it (people/UserMenu.tsx).
import { useTranslation } from 'react-i18next'
import { maxVolume, setVolume, useVoice } from '../state/voice'
import { Volume } from './icons'
import { formatNumber } from '../i18n/format'

/** One person's volume slider, "Mute for me" and reset. Right-click (or press and hold) someone you hear. */
export function VolumeControls({ accountKey, name, title, autoFocus }: { accountKey: string; name: string; title?: string; autoFocus?: boolean }) {
  const { t } = useTranslation()
  const volume = useVoice((s) => s.volumes[accountKey] ?? 1)
  const max = maxVolume()
  const shown = Math.min(volume, max)
  return (
    <>
      <div className="volume-menu-head">
        <strong>{title ?? name}</strong>
        <span className="muted">{formatNumber(shown, { style: 'percent' })}</span>
      </div>
      <label className="volume-menu-row">
        <Volume size={16} />
        <input
          type="range" min={0} max={max} step={0.05} value={shown} autoFocus={autoFocus}
          aria-label={t('voice.volume.for', { name })}
          onChange={(e) => setVolume(accountKey, Number(e.target.value))}
        />
      </label>
      <div className="volume-menu-actions">
        <button className="button small" onClick={() => setVolume(accountKey, 0)} disabled={shown === 0}>{t('voice.volume.muteForMe')}</button>
        <button className="button small" onClick={() => setVolume(accountKey, 1)} disabled={shown === 1}>{t('common.reset')}</button>
      </div>
      <p className="muted volume-menu-note">{t('voice.volume.note')}</p>
    </>
  )
}
