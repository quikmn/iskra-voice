// Settings → Voice & audio → Clips: opt in, and how long a clip is.
import { useTranslation } from 'react-i18next'
import { canClip, setClipSettings, useClips } from '../../state/clips'
import { MAX_CLIP_SECONDS, MIN_CLIP_SECONDS } from '../../state/clips/ring'
import { SwitchRow } from '../kit'

export function ClipSettingsSection() {
  const { t } = useTranslation()
  const settings = useClips((s) => s.settings)
  const supported = canClip()
  return (
    <section className="settings-section clip-settings">
      <h2>{t('clips.settings.title')}</h2>
      <p className="muted">{t('clips.settings.about')}</p>
      <SwitchRow title={t('clips.settings.enable')} checked={settings.enabled && supported} disabled={!supported} onChange={(on) => setClipSettings({ enabled: on })} />
      <label className="field">
        <span>{t('clips.settings.length', { seconds: settings.seconds })}</span>
        <input type="range" min={MIN_CLIP_SECONDS} max={MAX_CLIP_SECONDS} step={5} value={settings.seconds} disabled={!supported}
          aria-label={t('clips.settings.lengthLabel')} onChange={(e) => setClipSettings({ seconds: Number(e.target.value) })} />
      </label>
      <p className="muted">{supported ? t('clips.settings.privacy') : t('clips.unsupported')}</p>
    </section>
  )
}
