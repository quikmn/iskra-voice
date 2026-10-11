import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNotify } from '../../state/notify'
import { currentPushSupport, disablePush, enablePush, installApp, useInstall, usePush } from '../../state/push'
import { useApp } from '../../state/store'

/** Push notifications while Iskra is closed, and installing the web app. Not shown in the desktop app. */
export function PushSettings() {
  const { t } = useTranslation()
  const support = currentPushSupport()
  const wanted = useNotify((s) => s.push)
  const servers = usePush((s) => s.servers)
  const error = usePush((s) => s.error)
  const names = useApp((s) => s.servers)
  const installable = useInstall((s) => s.prompt !== null)
  const [busy, setBusy] = useState(false)
  if (support === 'desktop-app') return null

  const permission = typeof Notification === 'undefined' ? 'default' : Notification.permission
  const on = wanted && permission === 'granted'
  const failed = Object.entries(servers).filter(([, state]) => state === 'error').map(([key]) => names[key]?.name ?? t('settings.push.aServer'))
  const active = Object.values(servers).filter((state) => state === 'on').length

  async function toggle(checked: boolean) {
    setBusy(true)
    try {
      await (checked ? enablePush() : disablePush())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="push-settings">
      {support === 'supported' && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={on} disabled={busy || permission === 'denied'} onChange={(e) => void toggle(e.target.checked)} />
            {t('settings.push.toggle')}
          </label>
          {on && active > 0 && (
            <p className="muted push-status">
              {t('settings.push.onFor', { count: active })}
            </p>
          )}
          {on && failed.length > 0 && (
            <p className="push-error" role="alert">
              {t('settings.push.failed', { servers: failed.join(', '), error: error ? ` (${error})` : '' })}
            </p>
          )}
        </>
      )}
      {support === 'needs-install' && (
        <p className="muted push-hint">
          <Trans i18nKey="settings.push.ios" components={{ b: <strong /> }} />
        </p>
      )}
      {support === 'unsupported' && <p className="muted push-hint">{t('settings.push.unsupported')}</p>}
      {installable && (
        <div className="push-install">
          <span className="muted">{t('settings.push.getApp')}</span>
          <button className="button" onClick={() => void installApp()}>{t('settings.push.install')}</button>
        </div>
      )}
    </div>
  )
}
