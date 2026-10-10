import { PushSettings } from './PushSettings'
import { enableDesktopNotifications, notificationsSupported, playTone, updateNotify, useNotify } from '../../state/notify'

export function NotificationSettingsSection() {
  const { desktop, sounds } = useNotify()
  const blocked = notificationsSupported() && Notification.permission === 'denied'
  return (
    <section className="settings-section">
      <h3>Notifications</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={desktop && !blocked}
          disabled={!notificationsSupported() || blocked}
          onChange={(e) => (e.target.checked ? void enableDesktopNotifications() : updateNotify({ desktop: false }))}
        />
        Desktop notifications for mentions and direct messages
      </label>
      {blocked && <p className="muted">Notifications are blocked in your browser settings for this site.</p>}
      <PushSettings />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={sounds}
          onChange={(e) => {
            updateNotify({ sounds: e.target.checked })
            if (e.target.checked) playTone('message')
          }}
        />
        Sounds
      </label>
    </section>
  )
}
