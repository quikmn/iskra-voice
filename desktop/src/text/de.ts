// Deutsch. Same keys as ./en; the compiler flags anything missing or extra.
import type { DesktopText } from './en'

export const text: DesktopText = {
  tray: {
    open: 'Iskra öffnen',
    about: 'Über Iskra',
    check: 'Nach Updates suchen',
    checking: 'Sucht nach Updates…',
    downloading: (version: string) => `${version} wird heruntergeladen…`,
    restart: (version: string) => `Neu starten für Update auf ${version}`,
    download: (version: string) => `Iskra ${version} herunterladen`,
    quit: 'Iskra beenden',
  },
  updates: {
    titleReady: 'Update bereit',
    titleAvailable: 'Update verfügbar',
  },
  menu: { view: 'Ansicht' },
  recordings: {
    pickTitle: 'Wohin sollen Anrufaufnahmen?',
  },
  backup: {
    pickTitle: 'Server aus einem Backup wiederherstellen',
    filter: 'Iskra-Backups',
    notBackup: 'Diese Datei ist kein Iskra-Backup.',
  },
  bots: {
    pickTitle: 'Wähle einen Bot, dem du vertraust',
    pickMessage: 'Starte nur Bots, denen du vertraust: Ein Bot läuft mit deinen Rechten auf diesem Computer und kann deine Dateien lesen und ändern.',
    pickButton: 'Diesen Ordner nehmen',
    warnTitle: 'Starte nur Bots, denen du vertraust',
    runQuestion: (name: string) => `„${name}“ auf diesem Computer starten?`,
    autostartQuestion: (name: string) => `„${name}“ bei jedem Start von Iskra starten?`,
    changedQuestion: (name: string) => `„${name}“ hat sich seit dem letzten Start geändert. Trotzdem starten?`,
    warnDetail: (folder: string) => `${folder}

Dieser Bot läuft mit deinen Rechten auf diesem Computer: Er kann deine Dateien lesen und ändern. Starte nur Bots, denen du vertraust.`,
    run: 'Starten',
    autostart: 'Mit Iskra starten',
    cancel: 'Abbrechen',
  },
  template: {
    pickTitle: 'Server aus einer Vorlagendatei starten',
    filter: 'Iskra-Vorlagen',
    tooBig: 'Diese Datei ist zu groß für eine Vorlage.',
  },
  host: {
    defaultName: 'Mein Server',
    noServer: 'Dieser Build enthält den Server nicht.',
    stoppedEarly: 'Der Server hat direkt nach dem Start aufgehört. Ist sein Port belegt?',
    damaged: 'Die Dateien des Servers sind beschädigt, deshalb kann er nicht starten. In server.log in seinem Ordner steht, was nicht stimmt; ein Backup wiederherzustellen behebt es.',
    couldntStart: (error: string) => `Der Server konnte nicht starten: ${error}`,
    couldntRun: (error: string) => `Der Server konnte nicht laufen: ${error}`,
    restoreFailed: 'Das Backup ließ sich nicht wiederherstellen.',
    noPort: 'Kein freier Port gefunden.',
  },
  keys: {
    mouse: (button: number) => `Maus ${button}`,
    key: (code: number) => `Taste ${code}`,
  },
  passkey: {
    title: 'Iskra-Passkey',
    waiting: 'Folge der Aufforderung deines Geräts oder Sicherheitsschlüssels.',
  },
  splash: {
    title: 'Iskra',
    starting: 'Iskra startet…',
    servers: 'Deine Server starten…',
    connecting: 'Verbindet…',
    ready: 'Bereit',
    updatedTo: (version: string) => `Auf ${version} aktualisiert`,
    updating: (version: string) => `Iskra wird auf ${version} aktualisiert…`,
    updatingDetail: 'In ein paar Sekunden geht es weiter.',
  },
  assistant: {
    title: 'Iskra-Assistent',
    question: (host: string) => `Darf der Assistent deine Fragen an ${host} senden?`,
    detail: 'Sag nur Ja, wenn du diese Adresse selbst unter Meine Einstellungen → Assistent eingegeben hast. Was du den Assistenten fragst und was er für dich liest, geht dorthin.',
    yes: 'Ja, verwenden',
    no: 'Nein',
  },
  digitalOcean: {
    done: 'Mit DigitalOcean verbunden. Du kannst diesen Tab schließen und zu Iskra zurückgehen.',
    denied: 'Iskra wurde nicht mit DigitalOcean verbunden. Du kannst diesen Tab schließen und zu Iskra zurückgehen.',
  },
}
