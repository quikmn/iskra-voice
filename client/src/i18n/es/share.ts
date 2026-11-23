import type { Messages } from '../types'

// “Compartir en…”: texto, enlaces y archivos compartidos desde otra app (español).
export const share: Messages['share'] = {
  title: 'Compartir en…',
  preview: 'Lo que vas a compartir',
  message: 'Mensaje',
  messagePlaceholder: 'Agrega un mensaje (opcional)',
  skipped_one: 'No se pudo agregar {{count}} archivo (demasiado grande, o más de 10).',
  skipped_other: 'No se pudieron agregar {{count}} archivos (demasiado grandes, o más de 10).',
  sendToLabel: 'Enviar a',
  search: 'Buscar canales, personas y grupos',
  places: 'Lugares donde compartir',
  recent: 'Recientes',
  everywhere: 'En todas partes',
  nothing: 'No hay coincidencias.',
  loading: 'Conectando con tus servidores…',
  noServers: 'Primero únete a un servidor, y luego podrás compartir aquí.',
  dm: 'Mensaje directo',
  group: 'Grupo · {{server}}',
  sendTo: 'Enviar a {{target}}',
  sending: 'Enviando… {{percent}}',
  errors: {
    empty: 'No hay nada que enviar.',
    offline: 'Ese servidor no está conectado ahora. Vuelve a intentarlo en un momento.',
    tooBig: '{{name}} es más grande de lo que permite este servidor ({{max}}).',
    fileGone: '{{name}} ya no está disponible. Vuelve a compartirlo.',
  },
}
