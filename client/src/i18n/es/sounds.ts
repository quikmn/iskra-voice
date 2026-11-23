import type { Messages } from '../types'

// Sonidos de notificación (español): el conjunto integrado, tus elecciones, sonidos por servidor y por canal, y tu
// propio sonido.
export const sounds: Messages['sounds'] = {
  heading: 'Sonidos',
  names: {
    classic: 'Clásico',
    chime: 'Campanilla',
    pop: 'Pop',
    bell: 'Campana',
    droplet: 'Gota',
    marimba: 'Marimba',
    custom: 'Tu propio sonido',
    none: 'Sin sonido',
  },
  kinds: {
    message: 'Mensajes',
    mention: 'Menciones y respuestas',
    dm: 'Mensajes directos',
  },
  preview: 'Reproducir',
  previewOf: 'Reproducir {{sound}}',
  inherit: 'El mismo que el tuyo ({{sound}})',
  customMissing: 'Tu propio sonido (en este dispositivo suena Clásico)',
  syncHint: 'Tus elecciones te siguen a tus otros dispositivos. Un servidor o un canal puede tener un sonido propio: elígelo en su menú.',
  menuRow: 'Sonido',
  menuTitle: 'Sonido de {{place}}',
  yourDefault: 'Tu sonido',
  serverDefault: 'Sonido del servidor',
  custom: {
    heading: 'Tu propio sonido',
    upload: 'Subir un sonido',
    replace: 'Reemplazar',
    remove: 'Quitar',
    current: '{{name}} ({{seconds}} s)',
    hint: 'Un archivo de sonido corto: hasta 4 segundos y 1 MB. Se queda en este dispositivo y nunca se sube; en tus otros dispositivos suena Clásico.',
    problems: {
      notAudio: 'Eso no es un archivo de sonido.',
      tooBig: 'Ese archivo es demasiado grande. Elige uno de hasta 1 MB.',
      tooLong: 'Ese sonido es demasiado largo. Elige uno de hasta 4 segundos.',
      empty: 'Ese sonido está en silencio.',
      unreadable: 'Ese sonido no se pudo reproducir aquí. Prueba con un archivo MP3, Ogg o WAV.',
    },
  },
}
