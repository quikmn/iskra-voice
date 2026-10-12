import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop } from '../platform/desktop'
import { parseUpdatingVersion } from '../platform/updates'
import './update-toast.css'

/** Desktop only: covers the app for the moment before it quits into an update, so the window doesn't just vanish. */
export function UpdatingOverlay() {
  const { t } = useTranslation()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => desktop?.updates.onUpdating?.((v) => setVersion(parseUpdatingVersion(v))), [])

  if (!version) return null
  return (
    <div className="updating-overlay" role="alertdialog" aria-modal="true" aria-labelledby="updating-title" aria-describedby="updating-body">
      <svg className="updating-mark" viewBox="0 0 256 256" aria-hidden="true">
        <defs>
          <linearGradient id="updating-bolt" x1="60" y1="28" x2="196" y2="228" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#7c6fff" />
            <stop offset="100%" stopColor="#00cfff" />
          </linearGradient>
        </defs>
        <path d="M129 28L33 148h88l-18 80 120-144H129L145 28z" fill="url(#updating-bolt)" />
      </svg>
      <h1 id="updating-title">{t('app.update.updating', { version })}</h1>
      <p id="updating-body">{t('app.update.updatingBody')}</p>
      <div className="updating-track" role="progressbar" aria-labelledby="updating-title">
        <div className="updating-fill" />
      </div>
    </div>
  )
}
