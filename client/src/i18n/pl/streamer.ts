import type { Messages } from '../types'

export const streamer: Messages['streamer'] = {
  title: 'Tryb streamera',
  pill: 'Tryb streamera',
  pillHint: 'Tryb streamera jest włączony: linki z zaproszeniem, ID i podglądy są ukryte, a powiadomienia ciche. Wyłączysz go w Moich ustawieniach albo w menu statusu.',
  switch: 'Tryb streamera',
  switchHint: 'Na czas, gdy twój ekran jest na streamie: ukrywa linki i kody zaproszeń, ID kont i numery bezpieczeństwa, adresy e-mail w profilach i podglądy wiadomości oraz wycisza powiadomienia i dźwięki. Działa na twoim koncie także na innych urządzeniach.',
  on: 'Wł.',
  off: 'Wył.',
  autoTitle: 'Włączaj samoczynnie',
  auto: 'Gdy działa program z mojej listy poniżej',
  autoHint: 'Dodaj do listy programów OBS, Streamlabs albo to, czym streamujesz, a tryb streamera włączy się sam, gdy program działa, i wyłączy, gdy go zamkniesz. Tylko na tym komputerze i tylko dla dodanych przez ciebie programów.',
  autoNow: 'Działa program z twojej listy: tryb streamera jest włączony.',
  autoDesktopOnly: 'Aplikacja na komputer potrafi też włączać go sama, gdy działa twój program do streamowania:',
  hidden: 'Ukryte w trybie streamera',
  hiddenShort: 'Ukryte',
  menu: {
    on: 'Tryb streamera jest włączony',
    off: 'Tryb streamera',
    turnOff: 'Wyłącz',
    turnOn: 'Włącz',
    autoOn: 'Włączony, gdy działa twój program do streamowania',
  },
}
