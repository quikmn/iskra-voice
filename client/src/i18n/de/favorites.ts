import type { Messages } from '../types'

export const favorites: Messages['favorites'] = {
  section: 'Favoriten',
  add: 'Zu Favoriten hinzufügen',
  remove: 'Aus Favoriten entfernen',
  full: 'Du kannst bis zu {{count}} Favoriten haben.',
  row: '{{channel}} auf {{server}}',
  moveUp: '{{channel}} nach oben',
  moveDown: '{{channel}} nach unten',
  removeNamed: '{{channel}} aus Favoriten entfernen',
  hint: 'Zum Sortieren ziehen oder die Pfeile nutzen.',
  reorder: 'Favoriten sortieren',
  done: 'Fertig',
  edit: 'Bearbeiten',
}
