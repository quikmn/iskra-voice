import type { Messages } from '../types'

export const shell: Messages['shell'] = {
  members: {
    title: 'Membri',
    count_one: '{{count}} membro',
    count_other: '{{count}} membri',
    search: 'Cerca membri',
    searchPlaceholder: 'Trova qualcuno',
    clear: 'Cancella ricerca',
    close: 'Chiudi membri',
    none: 'Qui nessuno si chiama «{{query}}».',
  },
  recovery: {
    row: 'Salva la tua chiave di recupero',
    notSaved: 'Chiave di recupero non ancora salvata',
  },
}
