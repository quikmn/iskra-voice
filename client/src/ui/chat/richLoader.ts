// Loads richEngines.ts (highlighting and math) the first time a message needs it, so the main bundle stays small.
// Until then code shows with the small built-in highlighter and math as its source.
import { useEffect, useSyncExternalStore } from 'react'

type Engines = typeof import('./richEngines')

let engines: Engines | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function load(): void {
  loading ??= import('./richEngines').then((m) => {
    engines = m
    for (const l of listeners) l()
  }, () => {
    loading = null // offline mid-update: try again next time
  })
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The engines once loaded (null before); asks for them when `wanted`. */
export function useRichEngines(wanted = true): Engines | null {
  const loaded = useSyncExternalStore(subscribe, () => engines, () => engines)
  useEffect(() => {
    if (wanted && !engines) load()
  }, [wanted])
  return loaded
}
