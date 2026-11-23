import type { Messages } from '../types'

// Salas de voz que se crean al unirse (español): los lobbies de la lista de canales, el diálogo de ajustes de la sala
// y las opciones de menú del anfitrión.
export const rooms: Messages['rooms'] = {
  lobby: {
    join: 'Únete a {{name}} para tener tu propia sala',
    badge: 'Lobby',
    badgeHint: 'Al unirte se crea una sala de voz tuya, justo debajo de este canal.',
  },
  room: {
    locked: 'Bloqueada',
    lockedHint: '{{name}} está bloqueada: solo pueden unirse las personas que invite el anfitrión.',
    host: 'Anfitrión',
    hostOf: '{{name}} dirige esta sala',
    yours: 'Tu sala',
  },
  settings: {
    title: 'Ajustes de la sala',
    menu: 'Ajustes de la sala…',
    button: 'Tu sala',
    name: 'Nombre',
    nameHint: 'Se muestra como {{slug}}.',
    locked: 'Bloquear la sala',
    lockedHint: 'Mientras está bloqueada solo pueden unirse tú, las personas que invites y los moderadores. No se saca a nadie que ya esté dentro.',
    invite: 'Quién puede unirse mientras está bloqueada',
    invited: 'Con invitación',
    search: 'Buscar miembros',
    nobodyMatches: 'No hay coincidencias.',
    add: 'Invitar',
    remove: 'Quitar invitación',
    emptiesHint: 'La sala se quita unos 30 segundos después de que sale la última persona.',
  },
  userMenu: {
    invite: 'Invitar a {{room}}',
    uninvite: 'Quitar invitación a {{room}}',
  },
}
