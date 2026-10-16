// The desktop shell's own text (tray, file pickers, the splash, the window title) in the app's language.
// The page tells us its language (My settings → Language, or the system's); until it has, the OS decides.
// Anything the shell *says* to the person (an update check's result, About, permissions) is worded by the page
// itself (client/src/i18n), which gets a structured notice (notices.ts).

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
  updates: {
    titleReady: 'Update ready',
    titleAvailable: 'Update available',
  },
  menu: { view: 'View' },
  backup: {
    pickTitle: 'Restore a server from a backup',
    filter: 'Iskra backups',
    notBackup: "That file isn't an Iskra backup.",
  },
  template: {
    pickTitle: 'Start a server from a template file',
    filter: 'Iskra templates',
    tooBig: 'That file is too big for a template.',
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
  splash: {
    title: 'Iskra',
    starting: 'Starting Iskra…',
    servers: 'Starting your servers…',
    connecting: 'Connecting…',
    ready: 'Ready',
    updatedTo: (version: string) => `Updated to ${version}`,
    updating: (version: string) => `Updating Iskra to ${version}…`,
    updatingDetail: 'It’ll be back in a few seconds.',
  },
  digitalOcean: {
    done: 'Connected to DigitalOcean. You can close this tab and go back to Iskra.',
    denied: 'Iskra wasn’t connected to DigitalOcean. You can close this tab and go back to Iskra.',
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
  updates: {
    titleReady: 'Uppdatering klar',
    titleAvailable: 'Uppdatering finns',
  },
  menu: { view: 'Visa' },
  backup: {
    pickTitle: 'Återställ en server från en säkerhetskopia',
    filter: 'Säkerhetskopior från Iskra',
    notBackup: 'Den filen är ingen säkerhetskopia från Iskra.',
  },
  template: {
    pickTitle: 'Starta en server från en mallfil',
    filter: 'Mallar för Iskra',
    tooBig: 'Den filen är för stor för en mall.',
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
    title: 'Lösenordsnyckel för Iskra',
    waiting: 'Följ anvisningen från din enhet eller säkerhetsnyckel.',
  },
  splash: {
    title: 'Iskra',
    starting: 'Startar Iskra…',
    servers: 'Startar dina servrar…',
    connecting: 'Ansluter…',
    ready: 'Klart',
    updatedTo: (version) => `Uppdaterad till ${version}`,
    updating: (version) => `Uppdaterar Iskra till ${version}…`,
    updatingDetail: 'Iskra är tillbaka om några sekunder.',
  },
  digitalOcean: {
    done: 'Ansluten till DigitalOcean. Du kan stänga fliken och gå tillbaka till Iskra.',
    denied: 'Iskra anslöts inte till DigitalOcean. Du kan stänga fliken och gå tillbaka till Iskra.',
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
