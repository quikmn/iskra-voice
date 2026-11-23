import type { Messages } from '../types'

export const rooms: Messages['rooms'] = {
  lobby: {
    join: 'Dołącz do {{name}}, żeby dostać własny pokój',
    badge: 'Lobby',
    badgeHint: 'Po dołączeniu tuż pod spodem powstaje twój własny pokój głosowy.',
  },
  room: {
    locked: 'Zamknięty',
    lockedHint: 'Pokój {{name}} jest zamknięty: dołączyć mogą tylko osoby zaproszone przez gospodarza.',
    host: 'Gospodarz',
    hostOf: 'Gospodarz tego pokoju: {{name}}',
    yours: 'Twój pokój',
  },
  settings: {
    title: 'Ustawienia pokoju',
    menu: 'Ustawienia pokoju…',
    button: 'Twój pokój',
    name: 'Nazwa',
    nameHint: 'Widoczna jako {{slug}}.',
    locked: 'Zamknij pokój',
    lockedHint: 'Gdy jest zamknięty, dołączyć możesz tylko ty, zaproszone przez ciebie osoby i moderatorzy. Nikt, kto jest w środku, nie jest usuwany.',
    invite: 'Kto może dołączyć, gdy jest zamknięty',
    invited: 'Zaproszeni',
    search: 'Szukaj członków',
    nobodyMatches: 'Nikt nie pasuje.',
    add: 'Zaproś',
    remove: 'Cofnij zaproszenie',
    emptiesHint: 'Pokój znika około 30 sekund po wyjściu ostatniej osoby.',
  },
  userMenu: {
    invite: 'Zaproś do pokoju {{room}}',
    uninvite: 'Cofnij zaproszenie do pokoju {{room}}',
  },
}
