import type { Messages } from '../types'

// El canal AFK (español): su ajuste en el servidor, el silencio forzado y el aviso cuando te mueven.
export const afk: Messages['afk'] = {
  forced: 'Canal AFK: micrófono silenciado y audio desactivado',
  forcedHint: 'En el canal AFK el servidor silencia tu micrófono y no puedes oír a nadie. Únete a otro canal de voz para volver a hablar.',
  badge: 'AFK',
  channelHint: 'Canal AFK',
  participantForced: 'Micrófono silenciado y audio desactivado (canal AFK)',
  movedTitle: 'Te movieron a {{channel}}',
  movedBody: 'Pasaste {{minutes}} minutos sin actividad en la voz, así que {{server}} te movió a su canal AFK. Únete a cualquier canal de voz para volver.',
  movedBodyShort: 'Estuviste sin actividad en la voz, así que {{server}} te movió a su canal AFK. Únete a cualquier canal de voz para volver.',
  settings: {
    intro: 'Dales un lugar a quienes se alejan un rato. A quien pasa un tiempo sin actividad en un canal de voz se le mueve al canal AFK, donde queda con el micrófono silenciado y el audio desactivado.',
    channel: 'Canal AFK',
    none: 'Sin canal AFK',
    create: 'Crear canal AFK',
    defaultName: 'AFK',
    idle: 'Mover a quienes estén sin actividad después de',
    minutes: '{{n}} minutos',
    never: 'Nunca',
    idleHint: 'Sin actividad significa no escribir, hacer clic ni tocar (en cualquier parte de la computadora con la app de escritorio; en Iskra, en la web y los teléfonos) y no hablar, durante todo ese tiempo. A alguien que está hablando nunca se le mueve.',
    canTalk: 'Pueden hablar aquí',
    canTalkHint: 'A todos los demás del canal AFK el servidor les silencia el micrófono y les desactiva el audio, sean cuales sean sus propios ajustes.',
    baseRoles: 'Roles integrados',
    customRoles: 'Roles',
    saved: 'Guardado',
  },
}
