import type { Messages } from '../types'

export const rooms: Messages['rooms'] = {
  lobby: {
    join: 'Entre em {{name}} para ganhar uma sala só sua',
    badge: 'Lobby',
    badgeHint: 'Ao entrar, você ganha uma sala de voz só sua, logo abaixo deste canal.',
  },
  room: {
    locked: 'Trancada',
    lockedHint: '{{name}} está trancada: só entra quem o anfitrião convidar.',
    host: 'Anfitrião',
    hostOf: '{{name}} comanda esta sala',
    yours: 'Sua sala',
  },
  settings: {
    title: 'Configurações da sala',
    menu: 'Configurações da sala…',
    button: 'Sua sala',
    name: 'Nome',
    nameHint: 'Aparece como {{slug}}.',
    locked: 'Trancar a sala',
    lockedHint: 'Com a sala trancada, só entram você, quem você convidar e os moderadores. Ninguém que já está dentro é removido.',
    invite: 'Quem pode entrar com a sala trancada',
    invited: 'Convidados',
    search: 'Buscar membros',
    nobodyMatches: 'Ninguém encontrado.',
    add: 'Convidar',
    remove: 'Desconvidar',
    emptiesHint: 'A sala é removida cerca de 30 segundos depois que a última pessoa sai.',
  },
  userMenu: {
    invite: 'Convidar para {{room}}',
    uninvite: 'Desconvidar de {{room}}',
  },
}
