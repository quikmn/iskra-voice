// LiveKit is most of a megabyte of code: it loads when voice or video first starts (or once the app is idle, see
// App), not with the app. Code that only runs with a room (which needs loadLiveKit first) reads it with lk().
import type * as LiveKit from 'livekit-client'

let loaded: typeof LiveKit | null = null
let loading: Promise<typeof LiveKit> | null = null

export function loadLiveKit(): Promise<typeof LiveKit> {
  loading ??= import('livekit-client').then(
    (module) => (loaded = module),
    (e) => {
      loading = null // a failed fetch (offline): try again next time
      throw e
    },
  )
  return loading
}

/** The loaded module. Throws if nothing has loaded it yet (a bug: there can't be a room then). */
export function lk(): typeof LiveKit {
  if (!loaded) throw new Error('LiveKit is not loaded')
  return loaded
}

