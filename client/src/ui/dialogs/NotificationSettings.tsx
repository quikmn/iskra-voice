import { useTranslation } from 'react-i18next'
import { PushSettings } from './PushSettings'
import { AlertWordsSettings, FollowSettings, QuietHoursSettings } from '../alerts/AlertSettings'
import type { ServerState } from '../../state/store'
import { ServerNotifySettings } from '../organize/ServerSettings'
import { enableDesktopNotifications, notificationsSupported, updateNotify, useNotify } from '../../state/notify'
import { playSound, useSounds } from '../../state/sounds'
import { SoundSettings } from '../sounds/SoundSettings'
import { SwitchRow } from '../kit'

export function NotificationSettingsSection({ server }: { server?: ServerState | null }) {
  const { t } = useTranslation()
  const { desktop, sounds } = useNotify()
  const blocked = notificationsSupported() && Notification.permission === 'denied'
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.notifications')}</h2>
      <SwitchRow title={t('settings.notifications.desktop')} checked={desktop && !blocked} disabled={!notificationsSupported() || blocked} onChange={(on) => (on ? void enableDesktopNotifications() : updateNotify({ desktop: false }))} />
      {blocked && <p className="muted">{t('settings.notifications.blocked')}</p>}
      <PushSettings />
      <SwitchRow title={t('settings.notifications.sounds')} checked={sounds} onChange={(on) => {
            updateNotify({ sounds: on })
            if (on) playSound(useSounds.getState().prefs.message)
          }} />
      {sounds && <SoundSettings />}
      {server?.me && <ServerNotifySettings server={server} />}
      <AlertWordsSettings />
      <FollowSettings />
      <QuietHoursSettings />
    </section>
  )
}
