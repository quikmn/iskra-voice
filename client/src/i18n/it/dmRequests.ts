import type { Messages } from '../types'

export const dmRequests: Messages['dmRequests'] = {
  title: 'Richieste di messaggio',
  badge_one: '{{count}} richiesta di messaggio',
  badge_other: '{{count}} richieste di messaggio',
  empty: 'Nessuna nuova richiesta.',
  ignoredCount_one: 'Ignorate ({{count}})',
  ignoredCount_other: 'Ignorate ({{count}})',
  bar: '{{name}} vuole scriverti.',
  ignoredBar: 'Hai ignorato la richiesta di {{name}}.',
  barHint: "L'altra persona non sa se l'hai vista. Link e file restano nascosti finché non accetti.",
  accept: 'Accetta',
  ignore: 'Ignora',
  block: 'Blocca',
  filesHidden_one: '{{count}} file, nascosto finché non accetti',
  filesHidden_other: '{{count}} file, nascosti finché non accetti',
  settingTitle: 'Chi può scrivermi',
  refused: '{{server}} non ha accettato questa scelta e tiene quella precedente: {{reason}}',
  settingHint: 'Vale su tutti i server di cui fai parte. Le persone con cui hai già parlato possono sempre scriverti, e tu puoi comunque iniziare una conversazione con chiunque.',
  who: {
    anyone: 'Chiunque sui miei server',
    requests: 'Chiunque, come richiesta di messaggio',
    known: 'Persone con cui ho parlato e staff dei server',
    nobody: 'Solo persone con cui ho parlato',
  },
  whoHint: {
    anyone: 'I nuovi messaggi arrivano direttamente tra i tuoi messaggi diretti.',
    requests: 'Le persone nuove finiscono in Richieste di messaggio, senza notifiche, finché non accetti. Moderatori e admin passano direttamente.',
    known: 'Gli altri non possono iniziare una conversazione con te. Moderatori e admin sì.',
    nobody: 'Nessuna persona nuova può iniziare una conversazione con te, staff compreso.',
  },
}
