import type { Messages } from '../types'

export const voiceStatus: Messages['voiceStatus'] = {
  label: 'Röstkanalens status',
  none: 'Ingen status än',
  set: 'Sätt en status',
  edit: 'Ändra statusen',
  placeholder: 'Vad gör ni? Till exempel "CS2 ranked"',
  save: 'Spara',
  clear: 'Ta bort',
  setBy: 'Status satt av {{name}}',
  tooLong: 'Högst {{max}} tecken.',
  invalid: 'En rad, utan dolda tecken.',
  hint: 'Alla som ser kanalen ser den. Den försvinner när alla har gått.',
  encrypted: 'Rösten här är totalsträckskrypterad, men statusen är det inte: servern och alla som ser kanalen kan läsa den. Den försvinner när alla har gått.',
  clearMenu: 'Ta bort röststatus',
}
