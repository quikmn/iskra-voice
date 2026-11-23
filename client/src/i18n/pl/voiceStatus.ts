import type { Messages } from '../types'

export const voiceStatus: Messages['voiceStatus'] = {
  label: 'Status kanału głosowego',
  none: 'Brak statusu',
  set: 'Ustaw status',
  edit: 'Zmień status',
  placeholder: 'np. CS2, rankingowe',
  save: 'Zapisz',
  clear: 'Wyczyść',
  setBy: 'Status ustawia: {{name}}',
  tooLong: 'Maks. {{max}} znaków.',
  invalid: 'Jeden wiersz, bez niewidocznych znaków.',
  hint: 'Widzi go każdy, kto widzi kanał. Znika, gdy wszyscy wyjdą.',
  encrypted: 'Głos jest tu szyfrowany end-to-end, ale status nie: mogą go przeczytać serwer i każdy, kto widzi kanał. Znika, gdy wszyscy wyjdą.',
  clearMenu: 'Wyczyść status głosowy',
}
