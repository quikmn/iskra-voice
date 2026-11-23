import type { Messages } from '../types'

export const shell: Messages['shell'] = {
  members: {
    title: 'Mitglieder',
    count_one: '{{count}} Mitglied',
    count_other: '{{count}} Mitglieder',
    search: 'Mitglieder suchen',
    searchPlaceholder: 'Jemanden finden',
    clear: 'Suche leeren',
    close: 'Mitglieder schließen',
    none: 'Hier heißt niemand „{{query}}“.',
  },
  recovery: {
    row: 'Wiederherstellungsschlüssel sichern',
    notSaved: 'Wiederherstellungsschlüssel noch nicht gesichert',
  },
}
