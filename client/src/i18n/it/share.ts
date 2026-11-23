import type { Messages } from '../types'

export const share: Messages['share'] = {
  title: 'Condividi in…',
  preview: 'Cosa stai condividendo',
  message: 'Messaggio',
  messagePlaceholder: 'Aggiungi un messaggio (facoltativo)',
  skipped_one: 'Non è stato possibile aggiungere {{count}} file (troppo grande, o più di 10).',
  skipped_other: 'Non è stato possibile aggiungere {{count}} file (troppo grandi, o più di 10).',
  sendToLabel: 'Invia a',
  search: 'Cerca canali, persone e gruppi',
  places: 'Dove condividere',
  recent: 'Recenti',
  everywhere: 'Ovunque',
  nothing: 'Nessun risultato.',
  loading: 'Connessione ai tuoi server…',
  noServers: 'Prima entra in un server, poi potrai condividere qui.',
  dm: 'Messaggio diretto',
  group: 'Gruppo · {{server}}',
  sendTo: 'Invia a {{target}}',
  sending: 'Invio… {{percent}}',
  errors: {
    empty: 'Non c\'è niente da inviare.',
    offline: 'Al momento quel server non è connesso. Riprova tra un momento.',
    tooBig: '{{name}} supera la dimensione consentita da questo server ({{max}}).',
    fileGone: '{{name}} non è più disponibile. Condividilo di nuovo.',
  },
}
