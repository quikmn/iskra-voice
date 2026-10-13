// The settings views are a big share of the app's code: they load the first time settings open (or once the
// app is idle, see App), not with the app.
import { useEffect, useState, type ComponentType } from 'react'
import { closeSettings, useSettingsView } from './open'

let Views: ComponentType | null = null
let loading: Promise<void> | null = null

export function loadSettings(): Promise<void> {
  loading ??= import('./SettingsViews').then(
    (m) => void (Views = m.SettingsLayer),
    (e) => {
      loading = null // offline: try again next time
      throw e
    },
  )
  return loading
}

export function SettingsLayer() {
  const open = useSettingsView((s) => !!s.view)
  const [, loaded] = useState(0)
  useEffect(() => {
    if (open && !Views) loadSettings().then(() => loaded((n) => n + 1), closeSettings)
  }, [open])
  return open && Views ? <Views /> : null
}
