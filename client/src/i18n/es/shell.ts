import type { Messages } from '../types'

// La estructura de la app (español): el encabezado de la lista de miembros y el aviso de la clave de recuperación.
export const shell: Messages['shell'] = {
  members: {
    title: 'Miembros',
    count_one: '{{count}} miembro',
    count_other: '{{count}} miembros',
    search: 'Buscar miembros',
    searchPlaceholder: 'Buscar a alguien',
    clear: 'Borrar búsqueda',
    close: 'Cerrar miembros',
    none: 'Aquí no hay nadie con el nombre “{{query}}”.',
  },
  recovery: {
    row: 'Guarda tu clave de recuperación',
    notSaved: 'Aún no guardaste tu clave de recuperación',
  },
}
