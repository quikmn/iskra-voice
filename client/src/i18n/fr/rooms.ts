import type { Messages } from '../types'

// Join-to-create voice rooms: lobbies in the channel list, the room settings dialog, the host's menu items.
export const rooms: Messages['rooms'] = {
  lobby: {
    join: 'Rejoins {{name}} pour obtenir ta propre salle',
    badge: 'Lobby',
    badgeHint: 'En rejoignant, tu obtiens ta propre salle vocale, juste en dessous.',
  },
  room: {
    locked: 'Verrouillée',
    lockedHint: '{{name}} est verrouillée : seules les personnes invitées par l’hôte peuvent la rejoindre.',
    host: 'Hôte',
    hostOf: '{{name}} est l’hôte de cette salle',
    yours: 'Ta salle',
  },
  settings: {
    title: 'Paramètres de la salle',
    menu: 'Paramètres de la salle…',
    button: 'Ta salle',
    name: 'Nom',
    nameHint: 'Affiché sous la forme {{slug}}.',
    locked: 'Verrouiller la salle',
    lockedHint: 'Seuls toi, les personnes que tu invites et les modérateurs pouvez la rejoindre tant qu’elle est verrouillée. Personne à l’intérieur n’est retiré.',
    invite: 'Qui peut la rejoindre quand elle est verrouillée',
    invited: 'Invités',
    search: 'Rechercher des membres',
    nobodyMatches: 'Personne ne correspond.',
    add: 'Inviter',
    remove: 'Annuler l’invitation',
    emptiesHint: 'La salle est retirée environ 30 secondes après le départ de la dernière personne.',
  },
  userMenu: {
    invite: 'Inviter dans {{room}}',
    uninvite: 'Annuler l’invitation dans {{room}}',
  },
}
