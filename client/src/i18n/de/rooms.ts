import type { Messages } from '../types'

export const rooms: Messages['rooms'] = {
  lobby: {
    join: '{{name}} beitreten und einen eigenen Raum bekommen',
    badge: 'Lobby',
    badgeHint: 'Wer beitritt, bekommt einen eigenen Sprachraum, direkt darunter.',
  },
  room: {
    locked: 'Gesperrt',
    lockedHint: '{{name}} ist gesperrt: Nur wen der Host einlädt, kann beitreten.',
    host: 'Host',
    hostOf: '{{name}} ist Host dieses Raums',
    yours: 'Dein Raum',
  },
  settings: {
    title: 'Raumeinstellungen',
    menu: 'Raumeinstellungen…',
    button: 'Dein Raum',
    name: 'Name',
    nameHint: 'Wird als {{slug}} angezeigt.',
    locked: 'Raum sperren',
    lockedHint: 'Solange er gesperrt ist, können nur du, von dir Eingeladene und Moderatoren beitreten. Wer drin ist, bleibt drin.',
    invite: 'Wer beitreten kann, solange er gesperrt ist',
    invited: 'Eingeladen',
    search: 'Mitglieder suchen',
    nobodyMatches: 'Niemand passt.',
    add: 'Einladen',
    remove: 'Ausladen',
    emptiesHint: 'Der Raum wird etwa 30 Sekunden, nachdem die letzte Person gegangen ist, entfernt.',
  },
  userMenu: {
    invite: 'In {{room}} einladen',
    uninvite: 'Aus {{room}} ausladen',
  },
}
