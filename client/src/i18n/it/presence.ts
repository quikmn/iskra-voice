import type { Messages } from '../types'

export const presence: Messages['presence'] = {
  status: {
    online: 'Online',
    idle: 'Assente',
    dnd: 'Non disturbare',
    invisible: 'Invisibile',
    offline: 'Offline',
  },
  hints: {
    idle: 'Si imposta anche da solo quando ti allontani',
    dnd: 'Niente suoni, notifiche o push',
    invisible: 'Risulterai offline, ma puoi usare Iskra come sempre',
  },
  clearAfter: {
    '30m': '30 minuti',
    '1h': '1 ora',
    '4h': '4 ore',
    today: 'Oggi',
    never: 'Non rimuovere',
  },
  clearsInMinutes: 'Sparisce tra {{minutes}} min',
  clearsInHours: 'Sparisce tra {{hours}} h',
  setStatus: 'Imposta il tuo stato (ora {{status}})',
  yourStatus: 'Il tuo stato',
  setCustom: 'Imposta uno stato personalizzato',
  clearCustom: 'Rimuovi lo stato personalizzato',
  custom: {
    title: 'Stato personalizzato',
    clear: 'Rimuovi stato',
    hint: 'Compare accanto al tuo nome su tutti i server di cui fai parte.',
    label: 'Cosa succede?',
    changeEmoji: 'Emoji {{emoji}}, cambia',
    pickEmoji: "Scegli un'emoji",
    placeholder: 'es. In pausa pranzo',
    clearInput: 'Cancella testo ed emoji',
    clearAfter: 'Rimuovi dopo',
  },
  errors: {
    singleEmoji: 'Scegli una sola emoji.',
    tooLong: 'Gli stati personalizzati possono avere al massimo {{max}} caratteri.',
  },
  activity: {
    playing: 'Sta giocando a <b>{{name}}</b>',
    playingTitle: 'Sta giocando a {{name}}',
    justStarted: 'appena iniziato',
    minutes: '{{minutes}} min',
    hours: '{{hours}} h',
    hoursMinutes: '{{hours}} h {{minutes}} min',
  },
}
