import type { Messages } from '../types'

export const disappear: Messages['disappear'] = {
  title: 'Messaggi temporanei',
  timers: {
    '0': 'Disattivati',
    '300': '5 minuti',
    '3600': '1 ora',
    '28800': '8 ore',
    '86400': '1 giorno',
    '604800': '7 giorni',
    '2419200': '4 settimane',
  },
  short: {
    '300': '5 min',
    '3600': '1 h',
    '28800': '8 h',
    '86400': '1 g',
    '604800': '7 g',
    '2419200': '4 sett.',
  },
  button: 'Messaggi temporanei: {{state}}',
  intro: {
    dm: 'I nuovi messaggi in questa conversazione spariscono per entrambi allo scadere del tempo.',
    group: 'I nuovi messaggi in questo gruppo spariscono per tutti allo scadere del tempo.',
    channel: 'I nuovi messaggi in questo canale spariscono per tutti allo scadere del tempo.',
  },
  newOnly: 'Il cambio del timer vale solo per i messaggi inviati dopo.',
  deleted: 'Allo scadere del tempo, i messaggi e i loro file vengono eliminati dal server e dai dispositivi di tutti. I backup del server non li includono mai.',
  honest: 'Le persone possono comunque fare screenshot, copiare il testo o salvare i file prima che un messaggio sparisca.',
  managersOnly: 'Solo chi può gestire i canali può cambiare questa impostazione.',
  saving: 'Salvataggio…',
  line: {
    on: '{{name}} ha impostato i nuovi messaggi perché spariscano dopo {{duration}}.',
    off: '{{name}} ha disattivato i messaggi temporanei.',
    onYou: 'Hai impostato i nuovi messaggi perché spariscano dopo {{duration}}.',
    offYou: 'Hai disattivato i messaggi temporanei.',
  },
  expires: 'Sparisce {{time}}',
  fallback: {
    on: 'Ho impostato i nuovi messaggi perché spariscano dopo {{duration}}. (Aggiorna Iskra per vedere il timer.)',
    off: 'Ho disattivato i messaggi temporanei.',
  },
}
