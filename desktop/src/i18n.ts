// The desktop shell's own text (tray, About, native dialogs, update notices) in the app's language.
// The page tells us its language (Settings → Appearance → Language, or the system's); until it has, the OS decides.

export type DesktopLanguage = 'en' | 'sv'

const en = {
  tray: {
    open: 'Open Iskra',
    about: 'About Iskra',
    check: 'Check for updates',
    checking: 'Checking for updates…',
    downloading: (version: string) => `Downloading ${version}…`,
    restart: (version: string) => `Restart to update to ${version}`,
    download: (version: string) => `Download Iskra ${version}`,
    quit: 'Quit Iskra',
  },
  about: {
    title: 'About Iskra',
    version: (version: string, os: string, arch: string) => `Version ${version} (${os}, ${arch})`,
    tagline: 'Voice and text chat for friends, on servers you own.',
    license: 'Iskra is source-available under the PolyForm Noncommercial License 1.0.0.',
    builtOn: 'It builds on open source software, including Electron, Chromium, LiveKit, libsodium, React, RNNoise, DeepFilterNet, Silero VAD, Whisper, ONNX Runtime and MediaPipe.',
    buttons: ['OK', 'Website', 'License', 'Open source licenses'],
  },
  updates: {
    title: 'Iskra updates',
    downloading: (version: string) => `Iskra ${version} is downloading`,
    downloadingDetail: "It installs in the background. When it's ready, choose Restart to update from this menu or the app.",
    upToDate: "You're up to date",
    upToDateDetail: (version: string) => `Iskra ${version} is the newest version.`,
    off: 'Updates are off in this build',
    offDetail: "Development builds don't update themselves.",
    failed: "Couldn't check for updates",
    failedDetail: 'Check your internet connection and try again.',
    ok: 'OK',
  },
  screen: {
    message: 'Allow Iskra to share your screen',
    detail: 'Turn on Iskra under Privacy & Security → Screen & System Audio Recording in System Settings, then quit and reopen Iskra.',
    open: 'Open System Settings',
    notNow: 'Not now',
  },
  menu: { view: 'View' },
  backup: {
    pickTitle: 'Restore a server from a backup',
    filter: 'Iskra backups',
    notBackup: "That file isn't an Iskra backup.",
  },
  host: {
    defaultName: 'My server',
    noServer: "This build doesn't include the server.",
    stoppedEarly: 'The server stopped right after starting. Is its port in use?',
    damaged: "The server's files are damaged, so it can't start. server.log in its folder says what's wrong; restoring a backup fixes it.",
    couldntStart: (error: string) => `The server couldn't start: ${error}`,
    couldntRun: (error: string) => `The server couldn't run: ${error}`,
    restoreFailed: "The backup couldn't be restored.",
    noPort: 'No free port found.',
  },
  keys: {
    mouse: (button: number) => `Mouse ${button}`,
    key: (code: number) => `Key ${code}`,
  },
  passkey: {
    title: 'Iskra passkey',
    waiting: 'Follow the prompt from your device or security key.',
  },
}

export type DesktopText = typeof en

const sv: DesktopText = {
  tray: {
    open: 'Öppna Iskra',
    about: 'Om Iskra',
    check: 'Sök efter uppdateringar',
    checking: 'Söker efter uppdateringar…',
    downloading: (version) => `Laddar ner ${version}…`,
    restart: (version) => `Starta om och uppdatera till ${version}`,
    download: (version) => `Ladda ner Iskra ${version}`,
    quit: 'Avsluta Iskra',
  },
  about: {
    title: 'Om Iskra',
    version: (version, os, arch) => `Version ${version} (${os}, ${arch})`,
    tagline: 'Röst- och textchatt för vänner, på servrar du äger.',
    license: 'Iskras källkod är tillgänglig under PolyForm Noncommercial License 1.0.0.',
    builtOn: 'Iskra bygger på öppen källkod, bland annat Electron, Chromium, LiveKit, libsodium, React, RNNoise, DeepFilterNet, Silero VAD, Whisper, ONNX Runtime och MediaPipe.',
    buttons: ['OK', 'Webbplats', 'Licens', 'Licenser för öppen källkod'],
  },
  updates: {
    title: 'Iskra-uppdateringar',
    downloading: (version) => `Iskra ${version} laddas ner`,
    downloadingDetail: 'Den installeras i bakgrunden. När den är klar väljer du Starta om och uppdatera i den här menyn eller i appen.',
    upToDate: 'Du har senaste versionen',
    upToDateDetail: (version) => `Iskra ${version} är den senaste versionen.`,
    off: 'Uppdateringar är avstängda i den här versionen',
    offDetail: 'Utvecklingsversioner uppdaterar inte sig själva.',
    failed: 'Kunde inte söka efter uppdateringar',
    failedDetail: 'Kontrollera din internetanslutning och försök igen.',
    ok: 'OK',
  },
  screen: {
    message: 'Låt Iskra dela din skärm',
    detail: 'Slå på Iskra under Integritet och säkerhet → Skärm- och systemljudinspelning i Systeminställningar. Avsluta sedan Iskra och öppna appen igen.',
    open: 'Öppna Systeminställningar',
    notNow: 'Inte nu',
  },
  menu: { view: 'Visa' },
  backup: {
    pickTitle: 'Återställ en server från en säkerhetskopia',
    filter: 'Säkerhetskopior från Iskra',
    notBackup: 'Den filen är ingen säkerhetskopia från Iskra.',
  },
  host: {
    defaultName: 'Min server',
    noServer: 'Den här versionen innehåller inte servern.',
    stoppedEarly: 'Servern stannade direkt efter start. Används porten redan?',
    damaged: 'Serverns filer är skadade, så den kan inte starta. server.log i dess mapp berättar vad som är fel, och en säkerhetskopia löser det.',
    couldntStart: (error) => `Servern kunde inte starta: ${error}`,
    couldntRun: (error) => `Servern kunde inte köras: ${error}`,
    restoreFailed: 'Säkerhetskopian kunde inte återställas.',
    noPort: 'Hittade ingen ledig port.',
  },
  keys: {
    mouse: (button) => `Mus ${button}`,
    key: (code) => `Tangent ${code}`,
  },
  passkey: {
    title: 'Nyckel för Iskra',
    waiting: 'Följ anvisningen från din enhet eller säkerhetsnyckel.',
  },
}

export const DESKTOP_TEXT: Record<DesktopLanguage, DesktopText> = { en, sv }

/** Swedish when the first language we have among the OS's preferred ones is Swedish, else English. */
export function languageFromLocales(locales: readonly string[]): DesktopLanguage {
  for (const tag of locales) {
    const base = tag.toLowerCase().split(/[-_]/)[0]
    if (base === 'sv' || base === 'en') return base
  }
  return 'en'
}

export const parseLanguage = (value: unknown): DesktopLanguage | null => (value === 'en' || value === 'sv' ? value : null)

let current: DesktopLanguage = 'en'

export function setDesktopLanguage(language: DesktopLanguage): void {
  current = language
}

export const desktopLanguage = (): DesktopLanguage => current

/** The text in the current language. */
export const text = (): DesktopText => DESKTOP_TEXT[current]
