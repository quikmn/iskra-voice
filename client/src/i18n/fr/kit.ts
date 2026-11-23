import type { Messages } from '../types'

export const kit: Messages['kit'] = {
  unsaved: 'Tu as des modifications non enregistrées.',
  saveChanges: 'Enregistrer les modifications',
  nameRequired: 'Ton nom ne peut pas être vide.',
  // My settings: the nav's groups.
  myGroups: {
    you: 'Toi',
    app: 'Appli',
    privacy: 'Confidentialité et sécurité',
  },
  // The member sheet's moderation tabs.
  modTabs: {
    label: 'Outils de modération',
    timeout: 'Exclusion',
    warn: 'Avertir',
    notes: 'Notes',
    history: 'Historique',
  },
}
