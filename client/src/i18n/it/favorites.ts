import type { Messages } from '../types'

export const favorites: Messages['favorites'] = {
  section: 'Preferiti',
  add: 'Aggiungi ai preferiti',
  remove: 'Rimuovi dai preferiti',
  full: 'Puoi avere al massimo {{count}} preferiti.',
  row: '{{channel}} su {{server}}',
  moveUp: 'Sposta {{channel}} su',
  moveDown: 'Sposta {{channel}} giù',
  removeNamed: 'Rimuovi {{channel}} dai preferiti',
  hint: 'Trascina per riordinare, oppure usa le frecce.',
  reorder: 'Riordina i preferiti',
  done: 'Fatto',
  edit: 'Modifica',
}
