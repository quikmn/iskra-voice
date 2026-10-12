// Chromium's own background connections, kept off: the app only talks to the servers you use (plus the update check,
// which you can turn off). Checked by network.check.ts, which reads Chromium's network log.
import type { App, Session } from 'electron'
import { spellcheckDownloadsDictionaries } from './platform'

/** Before the app is ready. */
export function applyChromiumPrivacy(app: App): void {
  // No looking for Cast devices on the network, no autofill server, no <a ping>.
  app.commandLine.appendSwitch('disable-features', 'MediaRouter,DialMediaRouteProvider,AutofillServerCommunication')
  app.commandLine.appendSwitch('no-pings')
}

/**
 * Once the app is ready, for every session the app uses. Windows and macOS spellcheck with the system's own
 * spellchecker. On Linux Chromium would download Hunspell dictionaries from Google, so spellcheck stays off there.
 */
export function applySessionPrivacy(session: Session, platform: NodeJS.Platform = process.platform): void {
  if (!spellcheckDownloadsDictionaries(platform)) return
  session.setSpellCheckerEnabled(false)
  try {
    session.setSpellCheckerLanguages([])
  } catch {
    /* nothing to stop */
  }
}
