import type { Messages } from '../types'

export const favorites: Messages['favorites'] = {
  section: 'Favoriter',
  add: 'Lägg till som favorit',
  remove: 'Ta bort från favoriter',
  full: 'Du kan ha upp till {{count}} favoriter.',
  row: '{{channel}} på {{server}}',
  moveUp: 'Flytta upp {{channel}}',
  moveDown: 'Flytta ner {{channel}}',
  removeNamed: 'Ta bort {{channel}} från favoriter',
  hint: 'Dra för att ändra ordning, eller använd pilarna.',
  reorder: 'Ändra ordning på favoriter',
  done: 'Klar',
  edit: 'Ändra',
}
