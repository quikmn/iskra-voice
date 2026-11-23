// Svenska. Same keys as ./en; the compiler flags anything missing or extra.
import type { DesktopText } from './en'

export const text: DesktopText = {
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
  recordings: {
    pickTitle: 'Var ska samtalsinspelningar sparas?',
  },
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
    changedQuestion: (name: string) => `"${name}" har ändrats sedan du körde den senast. Köra den ändå?`,
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
