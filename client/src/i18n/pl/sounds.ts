import type { Messages } from '../types'

export const sounds: Messages['sounds'] = {
  heading: 'Dźwięki',
  names: {
    classic: 'Klasyczny',
    chime: 'Dzwoneczek',
    pop: 'Pyknięcie',
    bell: 'Dzwonek',
    droplet: 'Kropla',
    marimba: 'Marimba',
    custom: 'Własny dźwięk',
    none: 'Bez dźwięku',
  },
  kinds: {
    message: 'Wiadomości',
    mention: 'Wzmianki i odpowiedzi',
    dm: 'Wiadomości prywatne',
  },
  preview: 'Odtwórz',
  previewOf: 'Odtwórz: {{sound}}',
  inherit: 'Taki jak twój ({{sound}})',
  customMissing: 'Własny dźwięk (na tym urządzeniu gra Klasyczny)',
  syncHint: 'Twoje wybory działają też na innych twoich urządzeniach. Serwer albo kanał może mieć własny dźwięk: wybierz go w jego menu.',
  menuRow: 'Dźwięk',
  menuTitle: 'Dźwięk: {{place}}',
  yourDefault: 'Twój dźwięk',
  serverDefault: 'Dźwięk serwera',
  custom: {
    heading: 'Własny dźwięk',
    upload: 'Prześlij dźwięk',
    replace: 'Zastąp',
    remove: 'Usuń',
    current: '{{name}} ({{seconds}} s)',
    hint: 'Krótki plik dźwiękowy: maks. 4 sekundy i 1 MB. Zostaje na tym urządzeniu i nigdy nie jest przesyłany; na innych twoich urządzeniach gra Klasyczny.',
    problems: {
      notAudio: 'To nie jest plik dźwiękowy.',
      tooBig: 'Ten plik jest za duży. Wybierz plik do 1 MB.',
      tooLong: 'Ten dźwięk jest za długi. Wybierz dźwięk do 4 sekund.',
      empty: 'W tym pliku jest sama cisza.',
      unreadable: 'Tego dźwięku nie udało się tu odtworzyć. Spróbuj pliku MP3, Ogg lub WAV.',
    },
  },
}
