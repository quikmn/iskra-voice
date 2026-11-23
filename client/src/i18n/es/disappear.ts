import type { Messages } from '../types'

// Mensajes temporales (español).
export const disappear: Messages['disappear'] = {
  title: 'Mensajes temporales',
  timers: {
    '0': 'Desactivados',
    '300': '5 minutos',
    '3600': '1 hora',
    '28800': '8 horas',
    '86400': '1 día',
    '604800': '7 días',
    '2419200': '4 semanas',
  },
  short: {
    '300': '5 min',
    '3600': '1 h',
    '28800': '8 h',
    '86400': '1 d',
    '604800': '7 d',
    '2419200': '4 sem',
  },
  button: 'Mensajes temporales: {{state}}',
  intro: {
    dm: 'Los mensajes nuevos de esta conversación desaparecen para ustedes dos cuando se acaba el tiempo.',
    group: 'Los mensajes nuevos de este grupo desaparecen para todos cuando se acaba el tiempo.',
    channel: 'Los mensajes nuevos de este canal desaparecen para todos cuando se acaba el tiempo.',
  },
  newOnly: 'Cambiar el tiempo solo afecta a los mensajes enviados después del cambio.',
  deleted: 'Cuando se acaba su tiempo, los mensajes y sus archivos se eliminan del servidor y de los dispositivos de todos. Las copias de seguridad del servidor nunca los incluyen.',
  honest: 'Aun así, la gente puede hacer capturas de pantalla, copiar texto o guardar archivos antes de que un mensaje desaparezca.',
  managersOnly: 'Solo quienes pueden gestionar canales pueden cambiar esto.',
  saving: 'Guardando…',
  line: {
    on: '{{name}} hizo que los mensajes nuevos desaparezcan después de {{duration}}.',
    off: '{{name}} desactivó los mensajes temporales.',
    onYou: 'Hiciste que los mensajes nuevos desaparezcan después de {{duration}}.',
    offYou: 'Desactivaste los mensajes temporales.',
  },
  expires: 'Desaparece {{time}}',
  fallback: {
    on: 'Hice que los mensajes nuevos desaparezcan después de {{duration}}. (Actualiza Iskra para ver el tiempo.)',
    off: 'Desactivé los mensajes temporales.',
  },
}
