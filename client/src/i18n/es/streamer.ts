import type { Messages } from '../types'

// Modo streamer (español): la sección de ajustes, el interruptor rápido del menú de estado, el indicador y las máscaras.
export const streamer: Messages['streamer'] = {
  title: 'Modo streamer',
  pill: 'Modo streamer',
  pillHint: 'El modo streamer está activado: los enlaces de invitación, los ID y las vistas previas están ocultos, y las notificaciones no suenan. Desactívalo en Mis ajustes o en tu menú de estado.',
  switch: 'Modo streamer',
  switchHint: 'Para cuando tu pantalla sale en una transmisión: oculta los enlaces y códigos de invitación, los ID de cuenta y los números de seguridad, las direcciones de correo en los perfiles y las vistas previas de mensajes, y mantiene en silencio las notificaciones y los sonidos. Sigue a tu cuenta en tus otros dispositivos.',
  on: 'Activado',
  off: 'Desactivado',
  autoTitle: 'Activarse solo',
  auto: 'Mientras esté abierto un programa de mi lista de abajo',
  autoHint: 'Agrega OBS, Streamlabs o lo que uses para transmitir a la lista de programas, y el modo streamer se activa solo mientras ese programa está abierto y se desactiva cuando se cierra. Solo en esta computadora, y solo se buscan los programas que agregaste.',
  autoNow: 'Un programa de tu lista está abierto: el modo streamer está activado.',
  autoDesktopOnly: 'La app de escritorio también puede activarlo sola mientras tu programa de transmisión está abierto:',
  hidden: 'Oculto en modo streamer',
  hiddenShort: 'Oculto',
  menu: {
    on: 'El modo streamer está activado',
    off: 'Modo streamer',
    turnOff: 'Desactivar',
    turnOn: 'Activar',
    autoOn: 'Activado mientras tu programa de transmisión está abierto',
  },
}
