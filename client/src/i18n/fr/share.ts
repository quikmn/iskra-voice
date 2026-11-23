import type { Messages } from '../types'

// "Share to…": text, links and files shared from another app (the phone apps' share sheet).
export const share: Messages['share'] = {
  title: 'Partager vers…',
  preview: 'Ce que tu partages',
  message: 'Message',
  messagePlaceholder: 'Ajoute un message (facultatif)',
  skipped_one: '{{count}} fichier n’a pas pu être ajouté (trop volumineux, ou plus de 10).',
  skipped_other: '{{count}} fichiers n’ont pas pu être ajoutés (trop volumineux, ou plus de 10).',
  sendToLabel: 'Envoyer à',
  search: 'Rechercher des salons, des personnes et des groupes',
  places: 'Destinations de partage',
  recent: 'Récents',
  everywhere: 'Partout',
  nothing: 'Rien ne correspond.',
  loading: 'Connexion à tes serveurs…',
  noServers: 'Rejoins d’abord un serveur, tu pourras ensuite partager ici.',
  dm: 'Message privé',
  group: 'Groupe · {{server}}',
  sendTo: 'Envoyer à {{target}}',
  sending: 'Envoi… {{percent}}',
  errors: {
    empty: 'Il n’y a rien à envoyer.',
    offline: 'Ce serveur n’est pas connecté pour le moment. Réessaie dans un instant.',
    tooBig: '{{name}} dépasse la taille autorisée par ce serveur ({{max}}).',
    fileGone: '{{name}} n’est plus disponible. Partage-le de nouveau.',
  },
}
