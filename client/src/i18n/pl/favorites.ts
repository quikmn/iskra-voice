import type { Messages } from '../types'

export const favorites: Messages['favorites'] = {
  section: 'Ulubione',
  add: 'Dodaj do ulubionych',
  remove: 'Usuń z ulubionych',
  full: 'Możesz mieć maks. {{count}} ulubionych.',
  row: '{{channel}} na serwerze {{server}}',
  moveUp: 'Przenieś w górę: {{channel}}',
  moveDown: 'Przenieś w dół: {{channel}}',
  removeNamed: 'Usuń z ulubionych: {{channel}}',
  hint: 'Przeciągnij, żeby zmienić kolejność, albo użyj strzałek.',
  reorder: 'Zmień kolejność ulubionych',
  done: 'Gotowe',
  edit: 'Edytuj',
}
