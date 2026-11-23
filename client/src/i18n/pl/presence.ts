import type { Messages } from '../types'

export const presence: Messages['presence'] = {
  status: {
    online: 'Online',
    idle: 'Zaraz wracam',
    dnd: 'Nie przeszkadzać',
    invisible: 'Niewidoczny',
    offline: 'Offline',
  },
  hints: {
    idle: 'Ustawia się też sam, gdy odejdziesz od urządzenia',
    dnd: 'Bez dźwięków i powiadomień, także push',
    invisible: 'Wyglądasz na offline, ale Iskra działa jak zwykle',
  },
  clearAfter: {
    '30m': '30 minut',
    '1h': '1 godzina',
    '4h': '4 godziny',
    today: 'Dzisiaj',
    never: 'Nie czyść',
  },
  clearsInMinutes: 'Zniknie za {{minutes}} min',
  clearsInHours: 'Zniknie za {{hours}} godz.',
  setStatus: 'Ustaw status (teraz: {{status}})',
  yourStatus: 'Twój status',
  setCustom: 'Ustaw własny status',
  clearCustom: 'Wyczyść własny status',
  custom: {
    title: 'Własny status',
    clear: 'Wyczyść status',
    hint: 'Widoczny obok twojej nazwy na każdym twoim serwerze.',
    label: 'Co słychać?',
    changeEmoji: 'Emoji {{emoji}}, zmień',
    pickEmoji: 'Wybierz emoji',
    placeholder: 'np. Na obiedzie',
    clearInput: 'Wyczyść tekst i emoji',
    clearAfter: 'Wyczyść po',
  },
  errors: {
    singleEmoji: 'Wybierz jedno emoji.',
    tooLong: 'Własny status może mieć maks. {{max}} znaków.',
  },
  activity: {
    playing: 'W grze: <b>{{name}}</b>',
    playingTitle: 'W grze: {{name}}',
    justStarted: 'od niedawna',
    minutes: '{{minutes}} min',
    hours: '{{hours}} godz.',
    hoursMinutes: '{{hours}} godz. {{minutes}} min',
  },
}
