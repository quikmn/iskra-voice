import type { Messages } from '../types'

export const voiceStatus: Messages['voiceStatus'] = {
  label: 'Status des Sprachkanals',
  none: 'Noch kein Status',
  set: 'Status setzen',
  edit: 'Status ändern',
  placeholder: 'z. B. CS2 Ranked',
  save: 'Speichern',
  clear: 'Löschen',
  setBy: 'Status gesetzt von {{name}}',
  tooLong: 'Bis zu {{max}} Zeichen.',
  invalid: 'Eine Zeile, ohne unsichtbare Zeichen.',
  hint: 'Alle, die den Kanal sehen können, sehen ihn. Er verschwindet, wenn alle gegangen sind.',
  encrypted: 'Der Sprachchat ist hier Ende-zu-Ende-verschlüsselt, der Status aber nicht: Der Server und alle, die den Kanal sehen können, können ihn lesen. Er verschwindet, wenn alle gegangen sind.',
  clearMenu: 'Sprachstatus löschen',
}
