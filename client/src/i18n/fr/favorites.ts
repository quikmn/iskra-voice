import type { Messages } from '../types'

export const favorites: Messages['favorites'] = {
  section: 'Favoris',
  add: 'Ajouter aux favoris',
  remove: 'Retirer des favoris',
  full: 'Tu peux avoir jusqu’à {{count}} favoris.',
  row: '{{channel}} sur {{server}}',
  moveUp: 'Monter {{channel}}',
  moveDown: 'Descendre {{channel}}',
  removeNamed: 'Retirer {{channel}} des favoris',
  hint: 'Fais glisser pour réorganiser, ou utilise les flèches.',
  reorder: 'Réorganiser les favoris',
  done: 'Terminé',
  edit: 'Modifier',
}
