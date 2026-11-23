import type { Messages } from '../types'

export const afk: Messages['afk'] = {
  forced: 'Kanał AFK: mikrofon wyciszony i dźwięk wyłączony',
  forcedHint: 'Na kanale AFK serwer wycisza twój mikrofon i nikogo nie słyszysz. Dołącz do innego kanału głosowego, żeby znów rozmawiać.',
  badge: 'AFK',
  channelHint: 'Kanał AFK',
  participantForced: 'Mikrofon wyciszony i dźwięk wyłączony (kanał AFK)',
  movedTitle: 'Przeniesiono na {{channel}}',
  movedBody: 'Brak aktywności na kanale głosowym przez {{minutes}} min, więc serwer {{server}} przeniósł cię na swój kanał AFK. Dołącz do dowolnego kanału głosowego, żeby wrócić.',
  movedBodyShort: 'Brak aktywności na kanale głosowym, więc serwer {{server}} przeniósł cię na swój kanał AFK. Dołącz do dowolnego kanału głosowego, żeby wrócić.',
  settings: {
    intro: 'Daj osobom, które odchodzą od komputera, miejsce dla siebie. Kto przez jakiś czas jest nieaktywny na kanale głosowym, trafia na kanał AFK, gdzie ma wyciszony mikrofon i wyłączony dźwięk.',
    channel: 'Kanał AFK',
    none: 'Bez kanału AFK',
    create: 'Utwórz kanał AFK',
    defaultName: 'AFK',
    idle: 'Przenoś nieaktywne osoby po',
    minutes: '{{n}} min',
    never: 'Nigdy',
    idleHint: 'Nieaktywność to brak pisania, klikania i dotykania (w aplikacji na komputer: w całym komputerze; w przeglądarce i na telefonach: w aplikacji Iskra) oraz brak mówienia przez cały ten czas. Ktoś, kto mówi, nigdy nie jest przenoszony.',
    canTalk: 'Mogą tu mówić',
    canTalkHint: 'Wszystkim pozostałym na kanale AFK serwer wycisza mikrofon i wyłącza dźwięk, bez względu na ich własne ustawienia.',
    baseRoles: 'Role wbudowane',
    customRoles: 'Role',
    saved: 'Zapisano',
  },
}
