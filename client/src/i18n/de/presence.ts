import type { Messages } from '../types'

export const presence: Messages['presence'] = {
  status: {
    online: 'Online',
    idle: 'Abwesend',
    dnd: 'Nicht stören',
    invisible: 'Unsichtbar',
    offline: 'Offline',
  },
  hints: {
    idle: 'Wird auch automatisch gesetzt, wenn du weg bist',
    dnd: 'Keine Töne, Benachrichtigungen oder Pushs',
    invisible: 'Du wirkst offline, kannst Iskra aber wie gewohnt nutzen',
  },
  clearAfter: {
    '30m': '30 Minuten',
    '1h': '1 Stunde',
    '4h': '4 Stunden',
    today: 'Heute',
    never: 'Nicht löschen',
  },
  clearsInMinutes: 'Wird in {{minutes}} Min. gelöscht',
  clearsInHours: 'Wird in {{hours}} Std. gelöscht',
  setStatus: 'Status festlegen (jetzt {{status}})',
  yourStatus: 'Dein Status',
  setCustom: 'Eigenen Status festlegen',
  clearCustom: 'Eigenen Status löschen',
  custom: {
    title: 'Eigener Status',
    clear: 'Status löschen',
    hint: 'Steht auf allen deinen Servern neben deinem Namen.',
    label: 'Was ist los?',
    changeEmoji: 'Emoji {{emoji}}, ändern',
    pickEmoji: 'Emoji auswählen',
    placeholder: 'z. B. Mittagspause',
    clearInput: 'Text und Emoji löschen',
    clearAfter: 'Löschen nach',
  },
  errors: {
    singleEmoji: 'Wähle ein einzelnes Emoji.',
    tooLong: 'Ein eigener Status darf bis zu {{max}} Zeichen haben.',
  },
  activity: {
    playing: 'Spielt <b>{{name}}</b>',
    playingTitle: 'Spielt {{name}}',
    justStarted: 'gerade gestartet',
    minutes: '{{minutes}} Min.',
    hours: '{{hours}} Std.',
    hoursMinutes: '{{hours}} Std. {{minutes}} Min.',
  },
}
