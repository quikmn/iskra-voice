import type { Messages } from '../types'

export const disappear: Messages['disappear'] = {
  title: 'Znikające wiadomości',
  timers: {
    '0': 'Wył.',
    '300': '5 minut',
    '3600': '1 godzina',
    '28800': '8 godzin',
    '86400': '1 dzień',
    '604800': '7 dni',
    '2419200': '4 tygodnie',
  },
  short: {
    '300': '5 min',
    '3600': '1 godz.',
    '28800': '8 godz.',
    '86400': '1 d',
    '604800': '7 d',
    '2419200': '4 tyg.',
  },
  button: 'Znikające wiadomości: {{state}}',
  intro: {
    dm: 'Nowe wiadomości w tej rozmowie znikają u was obojga, gdy minie ustawiony czas.',
    group: 'Nowe wiadomości w tej grupie znikają u wszystkich, gdy minie ustawiony czas.',
    channel: 'Nowe wiadomości na tym kanale znikają u wszystkich, gdy minie ustawiony czas.',
  },
  newOnly: 'Zmiana czasu dotyczy tylko wiadomości wysłanych po zmianie.',
  deleted: 'Gdy minie ich czas, wiadomości i ich pliki są usuwane z serwera i z urządzeń wszystkich osób. Kopie zapasowe serwera nigdy ich nie zawierają.',
  honest: 'Zanim wiadomość zniknie, inni nadal mogą zrobić zrzut ekranu, skopiować tekst albo zapisać pliki.',
  managersOnly: 'To mogą zmieniać tylko osoby, które mogą zarządzać kanałami.',
  saving: 'Zapisywanie…',
  line: {
    on: '{{name}} ustawia znikanie nowych wiadomości, czas: {{duration}}.',
    off: '{{name}} wyłącza znikające wiadomości.',
    onYou: 'Ustawiasz znikanie nowych wiadomości, czas: {{duration}}.',
    offYou: 'Wyłączasz znikające wiadomości.',
  },
  expires: 'Zniknie {{time}}',
  fallback: {
    on: 'Ustawiam znikanie nowych wiadomości, czas: {{duration}}. (Zaktualizuj aplikację Iskra, żeby widzieć licznik.)',
    off: 'Wyłączam znikające wiadomości.',
  },
}
