// "Playing Factorio · 12 min" under someone's name.
import { useEffect, useState } from 'react'
import type { Activity } from '../core/protocol'
import { elapsed } from '../state/activity'
import './desktop.css'

export function ActivityLine({ activity, withTime = true }: { activity: Activity | null | undefined; withTime?: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!activity || !withTime) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [activity, withTime])
  if (!activity) return null
  return (
    <span className="activity-line" title={`Playing ${activity.name}`}>
      Playing <strong>{activity.name}</strong>
      {withTime && <> · {elapsed(activity.since, now)}</>}
    </span>
  )
}
