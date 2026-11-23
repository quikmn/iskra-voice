import type { Messages } from '../types'

export const shell: Messages['shell'] = {
  members: {
    title: 'Membres',
    count_one: '{{count}} membre',
    count_other: '{{count}} membres',
    search: 'Rechercher des membres',
    searchPlaceholder: 'Trouver quelqu’un',
    clear: 'Effacer la recherche',
    close: 'Fermer les membres',
    none: 'Personne ici ne s’appelle « {{query}} ».',
  },
  recovery: {
    row: 'Enregistre ta clé de récupération',
    notSaved: 'Clé de récupération pas encore enregistrée',
  },
}
