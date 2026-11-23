import type { Messages } from '../types'

export const favorites: Messages['favorites'] = {
  section: 'Избранное',
  add: 'Добавить в избранное',
  remove: 'Убрать из избранного',
  full: 'В избранном может быть не больше {{count}} каналов.',
  row: '{{channel}}, сервер {{server}}',
  moveUp: 'Поднять выше: {{channel}}',
  moveDown: 'Опустить ниже: {{channel}}',
  removeNamed: 'Убрать из избранного: {{channel}}',
  hint: 'Перетащите, чтобы изменить порядок, или используйте стрелки.',
  reorder: 'Изменить порядок избранного',
  done: 'Готово',
  edit: 'Изменить',
}
