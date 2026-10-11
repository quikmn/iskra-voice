import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop, type PushToTalkStatus } from '../../platform/desktop'
import { updateVoiceSettings, useVoice } from '../../state/voice'

/** Voice activity vs push-to-talk, and the key. Global key on desktop, in-page key on the web. */
export function VoiceSettingsSection() {
  const { t } = useTranslation()
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
      <h3>{t('settings.voice.inputMode')}</h3>
      <div className="segmented" role="radiogroup" aria-label={t('settings.voice.inputMode')}>
        <button role="radio" aria-checked={settings.mode === 'voice'} className={settings.mode === 'voice' ? 'on' : ''} onClick={() => updateVoiceSettings({ mode: 'voice' })}>
          {t('settings.voice.voiceActivity')}
        </button>
        <button role="radio" aria-checked={settings.mode === 'ptt'} className={settings.mode === 'ptt' ? 'on' : ''} onClick={() => updateVoiceSettings({ mode: 'ptt' })}>
          {t('settings.voice.ptt')}
        </button>
      </div>
      {settings.mode === 'ptt' && (
        <>
          <div className="copy-row">
            <span className={`key-chip ${pttDown ? 'down' : ''}`}>{capturing ? t('settings.voice.pressKey') : (key?.label ?? t('settings.voice.noKey'))}</span>
            <button className="button" onClick={() => void captureKey()} disabled={capturing}>
              {key ? t('settings.voice.changeKey') : t('settings.voice.setKey')}
            </button>
          </div>
          {desktop ? (
            <PushToTalkHint status={pttStatus} />
          ) : (
            <p className="muted">{t('settings.voice.browserPtt')}</p>
          )}
        </>
      )}
    </section>
  )
}

/** Desktop: whether the global key hook works here. Re-checked while open, so granting a permission shows up right away. */
export function usePushToTalkStatus(active: boolean): PushToTalkStatus {
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

export function PushToTalkHint({ status }: { status: PushToTalkStatus }) {
  const { t } = useTranslation()
  if (status === 'needs-permission') {
    return (
      <div>
        <p className="muted">{t('settings.voice.macPermission')}</p>
        <button className="button" onClick={() => void desktop?.openSystemSettings('accessibility')}>{t('settings.voice.openSystemSettings')}</button>
      </div>
    )
  }
  if (status === 'limited') return <p className="muted">{t('settings.voice.wayland')}</p>
  if (status === 'unavailable') return <p className="muted">{t('settings.voice.pttUnavailable')}</p>
  return <p className="muted">{t('settings.voice.worksEverywhere')}</p>
}
