import { useTranslation } from 'react-i18next'
import { PushSettings } from './PushSettings'
import { AlertWordsSettings, FollowSettings, QuietHoursSettings } from '../alerts/AlertSettings'
import type { ServerState } from '../../state/store'
import { ServerNotifySettings } from '../organize/ServerSettings'
import { enableDesktopNotifications, notificationsSupported, updateNotify, useNotify } from '../../state/notify'
import { playSound, useSounds } from '../../state/sounds'
import { SoundSettings } from '../sounds/SoundSettings'

export function NotificationSettingsSection({ server }: { server?: ServerState | null }) {
  const { t } = useTranslation()
  const { desktop, sounds } = useNotify()
  const blocked = notificationsSupported() && Notification.permission === 'denied'
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.notifications')}</h2>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={desktop && !blocked}
          disabled={!notificationsSupported() || blocked}
          onChange={(e) => (e.target.checked ? void enableDesktopNotifications() : updateNotify({ desktop: false }))}
        />
        {t('settings.notifications.desktop')}
      </label>
      {blocked && <p className="muted">{t('settings.notifications.blocked')}</p>}
      <PushSettings />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={sounds}
          onChange={(e) => {
            updateNotify({ sounds: e.target.checked })
            if (e.target.checked) playSound(useSounds.getState().prefs.message)
          }}
        />
        {t('settings.notifications.sounds')}
      </label>
      {sounds && <SoundSettings />}
      {server?.me && <ServerNotifySettings server={server} />}
      <AlertWordsSettings />
      <FollowSettings />
      <QuietHoursSettings />
    </section>
  )
}
