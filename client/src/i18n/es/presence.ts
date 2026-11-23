import type { Messages } from '../types'

// Presencia (español): estados, estado personalizado, actividad.
export const presence: Messages['presence'] = {
  status: {
    online: 'En línea',
    idle: 'Ausente',
    dnd: 'No molestar',
    invisible: 'Invisible',
    offline: 'Sin conexión',
  },
  hints: {
    idle: 'También se pone solo cuando te alejas',
    dnd: 'Sin sonidos ni notificaciones',
    invisible: 'Aparecerás sin conexión, pero puedes usar Iskra como siempre',
  },
  clearAfter: {
    '30m': '30 minutos',
    '1h': '1 hora',
    '4h': '4 horas',
    today: 'Hoy',
    never: 'No borrar',
  },
  clearsInMinutes: 'Se borra en {{minutes}} min',
  clearsInHours: 'Se borra en {{hours}} h',
  setStatus: 'Cambiar tu estado (ahora: {{status}})',
  yourStatus: 'Tu estado',
  setCustom: 'Poner un estado personalizado',
  clearCustom: 'Borrar estado personalizado',
  custom: {
    title: 'Estado personalizado',
    clear: 'Borrar estado',
    hint: 'Se muestra junto a tu nombre en todos tus servidores.',
    label: '¿Qué estás haciendo?',
    changeEmoji: 'Emoji {{emoji}}, cambiar',
    pickEmoji: 'Elegir un emoji',
    placeholder: 'p. ej. Salí a almorzar',
    clearInput: 'Borrar texto y emoji',
    clearAfter: 'Borrar después de',
  },
  errors: {
    singleEmoji: 'Elige un solo emoji.',
    tooLong: 'Un estado personalizado puede tener hasta {{max}} caracteres.',
  },
  activity: {
    playing: 'Jugando a <b>{{name}}</b>',
    playingTitle: 'Jugando a {{name}}',
    justStarted: 'acaba de empezar',
    minutes: '{{minutes}} min',
    hours: '{{hours}} h',
    hoursMinutes: '{{hours}} h {{minutes}} min',
  },
}
