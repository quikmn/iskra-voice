import type { Messages } from '../types'

export const voiceStatus: Messages['voiceStatus'] = {
  label: 'Stato del canale vocale',
  none: 'Ancora nessuno stato',
  set: 'Imposta uno stato',
  edit: 'Cambia lo stato',
  placeholder: 'es. CS2 classificata',
  save: 'Salva',
  clear: 'Rimuovi',
  setBy: 'Stato impostato da {{name}}',
  tooLong: 'Al massimo {{max}} caratteri.',
  invalid: 'Una sola riga, senza caratteri invisibili.',
  hint: 'Lo vede chiunque possa vedere il canale. Sparisce quando tutti sono usciti.',
  encrypted: 'Qui il vocale ha la crittografia end-to-end, ma lo stato no: possono leggerlo il server e chiunque possa vedere il canale. Sparisce quando tutti sono usciti.',
  clearMenu: 'Rimuovi lo stato del vocale',
}
