// Where other people's profile pages run. In the desktop app: a <webview> in a session of its own where nothing
// reaches the network (desktop/src/pages.ts), so scripts run for everyone. In browsers and the phone apps, a
// page's script can always reach the network through WebRTC in a child frame, so pages show without scripts there.
import { desktop } from '../../platform/desktop'

/** True in a desktop app that shows pages behind its wall. */
export const pageWall = (): boolean => !!desktop && !!globalThis.customElements?.get('webview')

/** A page view in the desktop app's page session. A new `src` means a new view (the shell checks each one when it attaches). */
export function PageWebview({ src, className, title }: { src: string; className: string; title: string }) {
  return <webview key={src} className={className} src={src} partition="iskra-pages" title={title} />
}
