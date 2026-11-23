import type { Messages } from '../types'

// Estado del canal de voz (español): la línea bajo un canal de voz y en la llamada.
export const voiceStatus: Messages['voiceStatus'] = {
  label: 'Estado del canal de voz',
  none: 'Aún sin estado',
  set: 'Poner un estado',
  edit: 'Cambiar el estado',
  placeholder: 'p. ej. Partida de CS2',
  save: 'Guardar',
  clear: 'Borrar',
  setBy: 'Estado puesto por {{name}}',
  tooLong: 'Hasta {{max}} caracteres.',
  invalid: 'Una sola línea, sin caracteres invisibles.',
  hint: 'Lo ven todos los que pueden ver el canal. Desaparece cuando todos salen.',
  encrypted: 'Aquí la voz está cifrada de extremo a extremo, pero el estado no: el servidor y todos los que pueden ver el canal pueden leerlo. Desaparece cuando todos salen.',
  clearMenu: 'Borrar estado de voz',
}
