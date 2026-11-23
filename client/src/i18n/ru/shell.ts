import type { Messages } from '../types'

export const shell: Messages['shell'] = {
  members: {
    title: 'Участники',
    count_one: '{{count}} участник',
    count_few: '{{count}} участника',
    count_many: '{{count}} участников',
    count_other: '{{count}} участника',
    search: 'Поиск участников',
    searchPlaceholder: 'Найти участника',
    clear: 'Очистить поиск',
    close: 'Закрыть список участников',
    none: 'Здесь нет никого с именем «{{query}}».',
  },
  recovery: {
    row: 'Сохраните ключ восстановления',
    notSaved: 'Ключ восстановления ещё не сохранён',
  },
}
