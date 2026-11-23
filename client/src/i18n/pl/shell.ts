import type { Messages } from '../types'

export const shell: Messages['shell'] = {
  members: {
    title: 'Członkowie',
    count_one: '{{count}} członek',
    count_few: '{{count}} członków',
    count_many: '{{count}} członków',
    count_other: '{{count}} członka',
    search: 'Szukaj członków',
    searchPlaceholder: 'Znajdź kogoś',
    clear: 'Wyczyść wyszukiwanie',
    close: 'Zamknij listę członków',
    none: 'Nie ma tu nikogo o nazwie „{{query}}”.',
  },
  recovery: {
    row: 'Zapisz klucz odzyskiwania',
    notSaved: 'Klucz odzyskiwania nie jest jeszcze zapisany',
  },
}
