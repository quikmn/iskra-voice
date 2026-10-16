import type { Messages } from '../types'

export const rooms: Messages['rooms'] = {
  lobby: {
    join: 'Gå med i {{name}} för att få ett eget rum',
    badge: 'Lobby',
    badgeHint: 'Den som går med får ett eget röstrum, precis under den här kanalen.',
  },
  room: {
    locked: 'Låst',
    lockedHint: '{{name}} är låst: bara den som värden bjuder in kan gå med.',
    host: 'Värd',
    hostOf: '{{name}} är värd för rummet',
    yours: 'Ditt rum',
  },
  settings: {
    title: 'Rummets inställningar',
    menu: 'Rummets inställningar…',
    button: 'Ditt rum',
    name: 'Namn',
    nameHint: 'Visas som {{slug}}.',
    locked: 'Lås rummet',
    lockedHint: 'Bara du, de du bjuder in och moderatorer kan gå med medan det är låst. Ingen som redan är inne tas bort.',
    invite: 'Vem som får gå med medan det är låst',
    invited: 'Inbjudna',
    search: 'Sök medlemmar',
    nobodyMatches: 'Ingen matchar.',
    add: 'Bjud in',
    remove: 'Ta bort inbjudan',
    emptiesHint: 'Rummet tas bort ungefär 30 sekunder efter att den sista personen gått.',
  },
  userMenu: {
    invite: 'Bjud in till {{room}}',
    uninvite: 'Ta bort inbjudan till {{room}}',
  },
}
