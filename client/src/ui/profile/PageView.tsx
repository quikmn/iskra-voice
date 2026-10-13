// Where other people's profile pages run. In the desktop app: a <webview> in a session of its own where nothing
// reaches the network (desktop/src/pages.ts), so scripts run for everyone. In browsers and the phone apps, a
// page's script can always reach the network through WebRTC in a child frame, so pages show without scripts there.
import { useCallback, useEffect, useRef, useState } from 'react'
import { desktop } from '../../platform/desktop'

/** True in a desktop app that shows pages behind its wall. */
export const pageWall = (): boolean => !!desktop && !!globalThis.customElements?.get('webview')

/** A page view in the desktop app's page session. A new `src` means a new view (the shell checks each one when it attaches). */
export function PageWebview({ src, className, title }: { src: string; className: string; title: string }) {
  const ref = useRef<HTMLElement>(null)
  const [loading, loaded] = useLoading(src)
  useEffect(() => {
    const view = ref.current
    if (!view) return
    view.addEventListener('did-finish-load', loaded)
    view.addEventListener('did-fail-load', loaded)
    return () => {
      view.removeEventListener('did-finish-load', loaded)
      view.removeEventListener('did-fail-load', loaded)
    }
  }, [src, loaded])
  return <webview ref={ref} key={src} className={`${className} ${loading}`} src={src} partition="iskra-pages" title={title} />
}

/**
 * A page view stays hidden until its page has loaded, so a dark page doesn't flash white first (the frame is white
 * behind pages without a background of their own). Shown after 3 s whatever happens. Returns the class to add and
 * the function to call on load.
 */
export function useLoading(key: string): [string, () => void] {
  const [done, setDone] = useState<string | null>(null)
  const loaded = useCallback(() => setDone(key), [key])
  useEffect(() => {
    const timer = setTimeout(loaded, 3000)
    return () => clearTimeout(timer)
  }, [loaded])
  return [done === key ? '' : 'page-loading', loaded]
}
