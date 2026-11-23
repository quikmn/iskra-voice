import type { Messages } from '../types'

// Plantillas iniciales (español): guardar un servidor como plantilla, crear uno desde un archivo y la vista previa.
export const templates: Messages['templates'] = {
  save: {
    title: 'Guardar este servidor como plantilla',
    intro: 'Un archivo con tus canales, quién puede verlos y usarlos, los roles, las reglas y los ajustes, para crear otro servidor igual a este. Nunca incluye miembros, mensajes, archivos ni claves.',
    button: 'Guardar como plantilla',
    done: 'Guardado',
  },
  file: {
    pick: 'Desde un archivo de plantilla…',
    hint: 'Una plantilla .json, por ejemplo una guardada desde otro servidor.',
    invalid: 'Ese archivo no es una plantilla que Iskra pueda usar: {{error}}',
    from: 'Desde {{file}}',
  },
  preview: {
    title: 'Qué configura',
    channels: 'Canales',
    roles: 'Roles',
    builtinRoles: 'Roles integrados',
    settings: 'Ajustes',
    kinds: { text: 'Texto', voice: 'Voz', forum: 'Foro', stage: 'Escenario', docs: 'Documentos' },
    whoRead: '{{role}} o superior puede verlo',
    whoWrite: '{{role}} o superior puede publicar',
    hifi: 'Alta fidelidad',
    slowmode: 'Modo lento {{seconds}} s',
    override: '{{role}}: {{changes}}',
    allow: 'puede {{what}}',
    deny: 'no puede {{what}}',
    perms: { view: 'ver', send: 'publicar', connect: 'unirse', speak: 'hablar' },
    tags: 'Etiquetas: {{tags}}',
    rolePermissions: '{{count}} permisos',
    noPermissions: 'Sin permisos adicionales',
    builtinChanged: '{{role}}: permisos cambiados',
    notifyDefault: 'Notificaciones predeterminadas: {{level}}',
    notifyAuto: 'automático',
    bots: 'Bots integrados: {{bots}}',
    limits: 'Límites de subida, emojis, stickers y sonidos',
    bugInbox: 'Los informes de errores van a {{channel}}',
    afk: 'Canal AFK: {{channel}} después de {{minutes}} min',
    rules: 'Reglas del servidor',
  },
}
