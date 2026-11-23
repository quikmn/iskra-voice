import type { Messages } from '../types'

export const afk: Messages['afk'] = {
  forced: 'Salon AFK : micro et son coupés',
  forcedHint: 'Dans le salon AFK, le serveur coupe ton micro et tu n’entends personne. Rejoins un autre salon vocal pour reparler.',
  badge: 'AFK',
  channelHint: 'Salon AFK',
  participantForced: 'Micro et son coupés (salon AFK)',
  movedTitle: 'Déplacement vers {{channel}}',
  movedBody: 'Après {{minutes}} minutes d’inactivité en vocal, {{server}} t’a fait passer dans son salon AFK. Rejoins n’importe quel salon vocal pour revenir.',
  movedBodyShort: 'Après un moment d’inactivité en vocal, {{server}} t’a fait passer dans son salon AFK. Rejoins n’importe quel salon vocal pour revenir.',
  settings: {
    intro: 'Donne un endroit où aller aux personnes qui s’absentent. Toute personne inactive un certain temps dans un salon vocal est déplacée vers le salon AFK, où son micro et son son sont coupés.',
    channel: 'Salon AFK',
    none: 'Pas de salon AFK',
    create: 'Créer un salon AFK',
    defaultName: 'AFK',
    idle: 'Déplacer les personnes inactives après',
    minutes: '{{n}} minutes',
    never: 'Jamais',
    idleHint: 'Inactif veut dire ni saisie, ni clic, ni appui (partout sur l’ordinateur dans l’appli de bureau, dans Iskra sur le web et sur téléphone) et aucune parole, pendant toute la durée. Une personne qui parle n’est jamais déplacée.',
    canTalk: 'Peuvent parler ici',
    canTalkHint: 'Toutes les autres personnes du salon AFK ont le micro et le son coupés par le serveur, quels que soient leurs propres paramètres.',
    baseRoles: 'Rôles intégrés',
    customRoles: 'Rôles',
    saved: 'Enregistré',
  },
}
