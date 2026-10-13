import type { Messages } from '../types'

export const presence: Messages['presence'] = {
  status: {
    online: 'Online',
    idle: 'Inaktiv',
    dnd: 'Stör ej',
    invisible: 'Osynlig',
    offline: 'Offline',
  },
  hints: {
    idle: 'Sätts också automatiskt när du är borta en stund',
    dnd: 'Inga ljud, aviseringar eller pushnotiser',
    invisible: 'Du ser offline ut, men kan använda Iskra som vanligt',
  },
  clearAfter: {
    '30m': '30 minuter',
    '1h': '1 timme',
    '4h': '4 timmar',
    today: 'I dag',
    never: 'Rensa inte',
  },
  clearsInMinutes: 'Försvinner om {{minutes}} min',
  clearsInHours: 'Försvinner om {{hours}} tim',
  setStatus: 'Ange din status (nu {{status}})',
  yourStatus: 'Din status',
  setCustom: 'Ange en egen status',
  clearCustom: 'Rensa egen status',
  custom: {
    title: 'Egen status',
    clear: 'Rensa status',
    hint: 'Visas bredvid ditt namn på alla servrar du är med i.',
    label: 'Vad händer?',
    changeEmoji: 'Emoji {{emoji}}, byt',
    pickEmoji: 'Välj en emoji',
    placeholder: 't.ex. Ute på lunch',
    clearInput: 'Rensa text och emoji',
    clearAfter: 'Rensa efter',
  },
  errors: {
    singleEmoji: 'Välj en enda emoji.',
    tooLong: 'En egen status kan vara högst {{max}} tecken.',
  },
  activity: {
    playing: 'Spelar <b>{{name}}</b>',
    playingTitle: 'Spelar {{name}}',
    justStarted: 'nyss startat',
    minutes: '{{minutes}} min',
    hours: '{{hours}} tim',
    hoursMinutes: '{{hours}} tim {{minutes}} min',
  },
}
