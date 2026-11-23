import type { Messages } from '../types'

export const claim: Messages['claim'] = {
  title: 'Przejmij serwer',
  entry: 'Masz serwer na DigitalOcean albo własnej maszynie, który pokazuje kod przejęcia? <a>Przejmij go</a>.',
  intro: 'Nowy serwer Iskra utworzony z DigitalOcean Marketplace pokazuje na konsoli swój adres i kod przejęcia (DigitalOcean: twój droplet → Console). Wpisz tutaj jedno i drugie, żeby zostać jego właścicielem.',
  address: 'Adres serwera',
  addressPlaceholder: 'https://203-0-113-7.sslip.io',
  addressHint: 'Taki jak na konsoli. Adres IP też zadziała.',
  badAddress: 'To nie wygląda na adres serwera. Użyj adresu https:// z konsoli.',
  code: 'Kod przejęcia',
  codePlaceholder: 'XXXX-XXXX-XXXX-XXXX',
  codeHint: '16 liter i cyfr. Wielkość liter, spacje i myślniki nie mają znaczenia.',
  badCode: 'Kod przejęcia ma 16 liter i cyfr, np. 7KQ2-ZM8P-X4TD-9HRA.',
  check: 'Sprawdź',
  checking: 'Sprawdzanie serwera…',
  found: 'To twój serwer. Dołączyć do niego jako właściciel?',
  join: 'Dołącz jako właściciel',
  back: 'Zmień',
  errors: {
    unreachable: 'Serwer nie odpowiedział. Sprawdź adres, a zupełnie nowemu serwerowi daj kilka minut na start i zdobycie certyfikatu.',
    noClaim: 'Ten serwer nie czeka na przejęcie: ma już właściciela albo jego kod wygasł po 24 godzinach. Żeby dostać nowy kod, uruchom serwer ponownie (na konsoli: sudo systemctl restart iskra) i sprawdź jeszcze raz.',
    wrongCode: 'Ten kod nie pasuje do tego serwera. Porównaj każdy znak z konsolą.',
    busy: 'Za dużo prób z tego miejsca. Poczekaj minutę i spróbuj ponownie.',
  },
  note: 'Kod zostaje na tym urządzeniu: aplikacja sprawdza tylko dowód serwera, że ma on ten sam kod. Działa raz, przez 24 godziny.',
}
