import type { Messages } from '../types'

export const sounds: Messages['sounds'] = {
  heading: 'Suoni',
  names: {
    classic: 'Classico',
    chime: 'Carillon',
    pop: 'Pop',
    bell: 'Campanella',
    droplet: 'Goccia',
    marimba: 'Marimba',
    custom: 'Il tuo suono',
    none: 'Nessun suono',
  },
  kinds: {
    message: 'Messaggi',
    mention: 'Menzioni e risposte',
    dm: 'Messaggi diretti',
  },
  preview: 'Ascolta',
  previewOf: 'Ascolta {{sound}}',
  inherit: 'Come il tuo ({{sound}})',
  customMissing: 'Il tuo suono (su questo dispositivo si sente Classico)',
  syncHint: 'Le tue scelte ti seguono sugli altri tuoi dispositivi. Un server o un canale può avere un suono tutto suo: sceglilo nel suo menu.',
  menuRow: 'Suono',
  menuTitle: 'Suono per {{place}}',
  yourDefault: 'Il tuo suono',
  serverDefault: 'Suono del server',
  custom: {
    heading: 'Il tuo suono',
    upload: 'Carica un suono',
    replace: 'Sostituisci',
    remove: 'Rimuovi',
    current: '{{name}} ({{seconds}} s)',
    hint: 'Un file audio breve: fino a 4 secondi e 1 MB. Resta su questo dispositivo e non viene mai caricato; sugli altri tuoi dispositivi si sente Classico.',
    problems: {
      notAudio: 'Non è un file audio.',
      tooBig: 'Quel file è troppo grande. Scegline uno fino a 1 MB.',
      tooLong: 'Quel suono è troppo lungo. Scegline uno fino a 4 secondi.',
      empty: 'Quel suono è muto.',
      unreadable: 'Qui non è stato possibile riprodurre quel suono. Prova con un file MP3, Ogg o WAV.',
    },
  },
}
