import type { Messages } from '../types'

// Quién puede escribirme y solicitudes de mensaje (español).
export const dmRequests: Messages['dmRequests'] = {
  title: 'Solicitudes de mensaje',
  badge_one: '{{count}} solicitud de mensaje',
  badge_other: '{{count}} solicitudes de mensaje',
  empty: 'No hay solicitudes nuevas.',
  ignoredCount_one: 'Ignoradas ({{count}})',
  ignoredCount_other: 'Ignoradas ({{count}})',
  bar: '{{name}} quiere enviarte un mensaje.',
  ignoredBar: 'Ignoraste la solicitud de {{name}}.',
  barHint: 'La otra persona no sabe si la viste. Los enlaces y archivos quedan ocultos hasta que aceptes.',
  accept: 'Aceptar',
  ignore: 'Ignorar',
  block: 'Bloquear',
  filesHidden_one: '{{count}} archivo, oculto hasta que aceptes',
  filesHidden_other: '{{count}} archivos, ocultos hasta que aceptes',
  settingTitle: 'Quién puede escribirme',
  refused: '{{server}} no aceptó esta opción y mantiene la anterior: {{reason}}',
  settingHint: 'Se aplica en todos tus servidores. Las personas con las que ya hablaste siempre pueden escribirte, y tú puedes seguir empezando una conversación con cualquiera.',
  who: {
    anyone: 'Cualquiera de mis servidores',
    requests: 'Cualquiera, como solicitud de mensaje',
    known: 'Personas con las que hablé y el equipo del servidor',
    nobody: 'Solo personas con las que hablé',
  },
  whoHint: {
    anyone: 'Los mensajes nuevos van directo a tus mensajes directos.',
    requests: 'Las personas nuevas llegan a Solicitudes de mensaje, sin notificaciones, hasta que aceptes. Los moderadores y admins pasan directo.',
    known: 'Los demás no pueden empezar una conversación contigo. Los moderadores y admins sí.',
    nobody: 'Nadie nuevo puede empezar una conversación contigo, tampoco el equipo del servidor.',
  },
}
