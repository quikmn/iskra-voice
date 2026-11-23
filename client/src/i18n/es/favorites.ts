import type { Messages } from '../types'

// Canales favoritos (español).
export const favorites: Messages['favorites'] = {
  section: 'Favoritos',
  add: 'Agregar a favoritos',
  remove: 'Quitar de favoritos',
  full: 'Puedes tener hasta {{count}} favoritos.',
  row: '{{channel}} en {{server}}',
  moveUp: 'Subir {{channel}}',
  moveDown: 'Bajar {{channel}}',
  removeNamed: 'Quitar {{channel}} de favoritos',
  hint: 'Arrastra para reordenar, o usa las flechas.',
  reorder: 'Reordenar favoritos',
  done: 'Listo',
  edit: 'Editar',
}
