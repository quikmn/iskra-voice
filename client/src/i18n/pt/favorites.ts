import type { Messages } from '../types'

export const favorites: Messages['favorites'] = {
  section: 'Favoritos',
  add: 'Adicionar aos favoritos',
  remove: 'Remover dos favoritos',
  full: 'Você pode ter até {{count}} favoritos.',
  row: '{{channel}} em {{server}}',
  moveUp: 'Mover {{channel}} para cima',
  moveDown: 'Mover {{channel}} para baixo',
  removeNamed: 'Remover {{channel}} dos favoritos',
  hint: 'Arraste para reordenar ou use as setas.',
  reorder: 'Reordenar favoritos',
  done: 'Concluir',
  edit: 'Editar',
}
