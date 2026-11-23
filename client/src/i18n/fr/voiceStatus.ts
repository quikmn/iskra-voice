import type { Messages } from '../types'

export const voiceStatus: Messages['voiceStatus'] = {
  label: 'Statut du salon vocal',
  none: 'Pas encore de statut',
  set: 'Définir un statut',
  edit: 'Changer le statut',
  placeholder: 'ex. : CS2 classé',
  save: 'Enregistrer',
  clear: 'Effacer',
  setBy: 'Statut défini par {{name}}',
  tooLong: 'Jusqu’à {{max}} caractères.',
  invalid: 'Une seule ligne, sans caractères invisibles.',
  hint: 'Toutes les personnes qui peuvent voir le salon le voient. Il disparaît quand tout le monde est parti.',
  encrypted: 'Le vocal est ici chiffré de bout en bout, mais pas le statut : le serveur et toutes les personnes qui peuvent voir le salon peuvent le lire. Il disparaît quand tout le monde est parti.',
  clearMenu: 'Effacer le statut vocal',
}
