import type { Messages } from '../types'

export const dmRequests: Messages['dmRequests'] = {
  title: 'Demandes de message',
  badge_one: '{{count}} demande de message',
  badge_other: '{{count}} demandes de message',
  empty: 'Aucune nouvelle demande.',
  ignoredCount_one: 'Ignorée ({{count}})',
  ignoredCount_other: 'Ignorées ({{count}})',
  bar: '{{name}} veut t’écrire.',
  ignoredBar: 'Tu as ignoré la demande de {{name}}.',
  barHint: 'Cette personne ne sait pas si tu l’as vue. Les liens et les fichiers restent masqués jusqu’à ce que tu acceptes.',
  accept: 'Accepter',
  ignore: 'Ignorer',
  block: 'Bloquer',
  filesHidden_one: '{{count}} fichier, masqué jusqu’à ce que tu acceptes',
  filesHidden_other: '{{count}} fichiers, masqués jusqu’à ce que tu acceptes',
  settingTitle: 'Qui peut m’écrire',
  refused: '{{server}} n’a pas pris en compte ce choix et garde le précédent : {{reason}}',
  settingHint: 'S’applique sur tous tes serveurs. Les personnes avec qui tu as déjà discuté peuvent toujours t’écrire, et tu peux toujours lancer une conversation avec n’importe qui.',
  who: {
    anyone: 'Tout le monde sur mes serveurs',
    requests: 'Tout le monde, par une demande de message',
    known: 'Les personnes avec qui j’ai discuté, et l’équipe des serveurs',
    nobody: 'Seulement les personnes avec qui j’ai discuté',
  },
  whoHint: {
    anyone: 'Les nouveaux messages arrivent directement dans tes messages privés.',
    requests: 'Les nouvelles personnes arrivent dans Demandes de message, sans notification, jusqu’à ce que tu acceptes. Les modérateurs et les admins passent directement.',
    known: 'Les autres ne peuvent pas lancer de conversation avec toi. Les modérateurs et les admins, si.',
    nobody: 'Aucune nouvelle personne ne peut lancer de conversation avec toi, équipe des serveurs comprise.',
  },
}
