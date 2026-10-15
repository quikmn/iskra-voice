import type { Messages } from '../types'

export const disappear: Messages['disappear'] = {
  title: 'Försvinnande meddelanden',
  timers: {
    '0': 'Av',
    '300': '5 minuter',
    '3600': '1 timme',
    '28800': '8 timmar',
    '86400': '1 dag',
    '604800': '7 dagar',
    '2419200': '4 veckor',
  },
  short: {
    '300': '5 min',
    '3600': '1 h',
    '28800': '8 h',
    '86400': '1 d',
    '604800': '7 d',
    '2419200': '4 v',
  },
  button: 'Försvinnande meddelanden: {{state}}',
  intro: {
    dm: 'Nya meddelanden i konversationen försvinner för er båda när tiden har gått.',
    group: 'Nya meddelanden i gruppen försvinner för alla när tiden har gått.',
    channel: 'Nya meddelanden i kanalen försvinner för alla när tiden har gått.',
  },
  newOnly: 'Ändrar du tiden gäller det bara meddelanden som skickas efteråt.',
  deleted: 'När tiden har gått raderas meddelandena och deras filer från servern och från allas enheter. Serverns säkerhetskopior tar aldrig med dem.',
  honest: 'Folk kan fortfarande ta skärmdumpar, kopiera text eller spara filer innan ett meddelande försvinner.',
  managersOnly: 'Bara den som får hantera kanaler kan ändra det här.',
  saving: 'Sparar…',
  line: {
    on: '{{name}} ställde in att nya meddelanden försvinner efter {{duration}}.',
    off: '{{name}} stängde av försvinnande meddelanden.',
    onYou: 'Du ställde in att nya meddelanden försvinner efter {{duration}}.',
    offYou: 'Du stängde av försvinnande meddelanden.',
  },
  expires: 'Försvinner {{time}}',
  fallback: {
    on: 'Jag ställde in att nya meddelanden försvinner efter {{duration}}. (Uppdatera Iskra för att se tiden.)',
    off: 'Jag stängde av försvinnande meddelanden.',
  },
}
