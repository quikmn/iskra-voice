// "Playing Factorio · 12 min" under someone's name.
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { Activity } from '../core/protocol'
import { elapsed } from '../state/activity'
import './desktop.css'

export function ActivityLine({ activity, withTime = true }: { activity: Activity | null | undefined; withTime?: boolean }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!activity || !withTime) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [activity, withTime])
  if (!activity) return null
  return (
    <span className="activity-line" title={t('presence.activity.playingTitle', { name: activity.name })}>
      <Trans i18nKey="presence.activity.playing" values={{ name: activity.name }} components={{ b: <strong /> }} />
      {withTime && <> · {elapsed(activity.since, now)}</>}
    </span>
  )
}
