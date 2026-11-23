import type { Messages } from '../types'

export const share: Messages['share'] = {
  title: 'Teilen mit…',
  preview: 'Was du teilst',
  message: 'Nachricht',
  messagePlaceholder: 'Nachricht hinzufügen (optional)',
  skipped_one: '{{count}} Datei ließ sich nicht hinzufügen (zu groß oder mehr als 10).',
  skipped_other: '{{count}} Dateien ließen sich nicht hinzufügen (zu groß oder mehr als 10).',
  sendToLabel: 'Senden an',
  search: 'Kanäle, Personen und Gruppen suchen',
  places: 'Ziele zum Teilen',
  recent: 'Zuletzt',
  everywhere: 'Überall',
  nothing: 'Nichts passt.',
  loading: 'Verbindet mit deinen Servern…',
  noServers: 'Tritt erst einem Server bei, dann kannst du hier teilen.',
  dm: 'Direktnachricht',
  group: 'Gruppe · {{server}}',
  sendTo: 'An {{target}} senden',
  sending: 'Sendet… {{percent}}',
  errors: {
    empty: 'Es gibt nichts zu senden.',
    offline: 'Dieser Server ist gerade nicht verbunden. Versuch es gleich nochmal.',
    tooBig: '{{name}} ist größer, als dieser Server erlaubt ({{max}}).',
    fileGone: '{{name}} ist nicht mehr verfügbar. Teile die Datei nochmal.',
  },
}
