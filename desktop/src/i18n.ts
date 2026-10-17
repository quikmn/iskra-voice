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
  bots: {
    pickTitle: 'Choose a bot you trust',
    pickMessage: 'Only run bots you trust: a bot runs with your rights on this computer and can read and change your files.',
    pickButton: 'Use this folder',
    warnTitle: 'Only run bots you trust',
    runQuestion: (name: string) => `Run "${name}" on this computer?`,
    autostartQuestion: (name: string) => `Start "${name}" every time Iskra starts?`,
    warnDetail: (folder: string) => `${folder}

This bot runs with your rights on this computer: it can read and change your files. Only run bots you trust.`,
    run: 'Run it',
    autostart: 'Start it with Iskra',
    cancel: 'Cancel',
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
  assistant: {
    title: 'Iskra assistant',
    question: (host: string) => `Let the assistant send your questions to ${host}?`,
    detail: 'Only say yes if you entered this address yourself in My settings → Assistant. What you ask the assistant, and what it reads for you, will go there.',
    yes: 'Yes, use it',
    no: 'No',
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
  bots: {
    pickTitle: 'Välj en bot du litar på',
    pickMessage: 'Kör bara bottar du litar på: en bot körs med dina rättigheter på den här datorn och kan läsa och ändra dina filer.',
    pickButton: 'Använd den här mappen',
    warnTitle: 'Kör bara bottar du litar på',
    runQuestion: (name: string) => `Köra "${name}" på den här datorn?`,
    autostartQuestion: (name: string) => `Starta "${name}" varje gång Iskra startar?`,
    warnDetail: (folder: string) => `${folder}

Botten körs med dina rättigheter på den här datorn: den kan läsa och ändra dina filer. Kör bara bottar du litar på.`,
    run: 'Kör den',
    autostart: 'Starta den med Iskra',
    cancel: 'Avbryt',
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
  assistant: {
    title: 'Iskras assistent',
    question: (host) => `Låta assistenten skicka dina frågor till ${host}?`,
    detail: 'Säg bara ja om du själv skrev in adressen i Mina inställningar → Assistent. Det du frågar assistenten, och det den läser åt dig, skickas dit.',
    yes: 'Ja, använd den',
    no: 'Nej',
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
