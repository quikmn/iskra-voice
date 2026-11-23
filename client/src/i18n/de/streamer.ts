import type { Messages } from '../types'

export const streamer: Messages['streamer'] = {
  title: 'Streamer-Modus',
  pill: 'Streamer-Modus',
  pillHint: 'Der Streamer-Modus ist an: Einladungslinks, IDs und Vorschauen sind verborgen, und Benachrichtigungen bleiben still. Ausschalten kannst du ihn in Meine Einstellungen oder in deinem Statusmenü.',
  switch: 'Streamer-Modus',
  switchHint: 'Für den Fall, dass dein Bildschirm im Stream zu sehen ist: verbirgt Einladungslinks und -codes, Konto-IDs und Sicherheitsnummern, E-Mail-Adressen in Profilen und Nachrichtenvorschauen und hält Benachrichtigungen und Töne still. Folgt deinem Konto auf deine anderen Geräte.',
  on: 'An',
  off: 'Aus',
  autoTitle: 'Von selbst einschalten',
  auto: 'Solange ein Programm aus meiner Liste unten läuft',
  autoHint: 'Füge OBS, Streamlabs oder womit du sonst streamst zur Programmliste hinzu. Der Streamer-Modus schaltet sich dann ein, solange es läuft, und aus, wenn du es beendest. Nur auf diesem Computer, und es wird nur nach den Programmen gesucht, die du hinzugefügt hast.',
  autoNow: 'Ein Programm aus deiner Liste läuft: Der Streamer-Modus ist an.',
  autoDesktopOnly: 'Die Desktop-App kann ihn auch von selbst einschalten, solange dein Streaming-Programm läuft:',
  hidden: 'Im Streamer-Modus verborgen',
  hiddenShort: 'Verborgen',
  menu: {
    on: 'Streamer-Modus ist an',
    off: 'Streamer-Modus',
    turnOff: 'Ausschalten',
    turnOn: 'Einschalten',
    autoOn: 'An, solange dein Streaming-Programm läuft',
  },
}
