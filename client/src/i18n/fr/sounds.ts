import type { Messages } from '../types'

// Notification sounds.
export const sounds: Messages['sounds'] = {
  heading: 'Sons',
  names: {
    classic: 'Classique',
    chime: 'Carillon',
    pop: 'Pop',
    bell: 'Cloche',
    droplet: 'Goutte',
    marimba: 'Marimba',
    custom: 'Ton propre son',
    none: 'Aucun son',
  },
  kinds: {
    message: 'Messages',
    mention: 'Mentions et réponses',
    dm: 'Messages privés',
  },
  preview: 'Écouter',
  previewOf: 'Écouter {{sound}}',
  inherit: 'Comme le tien ({{sound}})',
  customMissing: 'Ton propre son (Classique sur cet appareil)',
  syncHint: 'Tes choix te suivent sur tes autres appareils. Un serveur ou un salon peut avoir son propre son : choisis-le dans son menu.',
  menuRow: 'Son',
  menuTitle: 'Son pour {{place}}',
  yourDefault: 'Ton son',
  serverDefault: 'Son du serveur',
  custom: {
    heading: 'Ton propre son',
    upload: 'Importer un son',
    replace: 'Remplacer',
    remove: 'Retirer',
    current: '{{name}} ({{seconds}} s)',
    hint: 'Un fichier son court : jusqu’à 4 secondes et 1 Mo. Il reste sur cet appareil et n’est jamais envoyé ailleurs ; tes autres appareils jouent Classique à la place.',
    problems: {
      notAudio: 'Ce n’est pas un fichier son.',
      tooBig: 'Ce fichier est trop volumineux. Choisis-en un de 1 Mo au maximum.',
      tooLong: 'Ce son est trop long. Choisis-en un de 4 secondes au maximum.',
      empty: 'Ce son est silencieux.',
      unreadable: 'Ce son n’a pas pu être lu ici. Essaie un fichier MP3, Ogg ou WAV.',
    },
  },
}
