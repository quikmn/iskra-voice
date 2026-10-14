import type { Messages } from '../types'

export const claim: Messages['claim'] = {
  title: 'Gör anspråk på en server',
  entry: 'Har du skapat en server hos DigitalOcean eller på en egen dator som visar en anspråkskod? <a>Gör anspråk på den</a>.',
  intro: 'En ny Iskra-server från DigitalOcean Marketplace visar sin adress och en anspråkskod i sin konsol (DigitalOcean: din droplet → Console). Skriv in båda här så blir du serverns ägare.',
  address: 'Serverns adress',
  addressPlaceholder: 'https://203-0-113-7.sslip.io',
  addressHint: 'Som den står i konsolen. En IP-adress går också bra.',
  badAddress: 'Det där ser inte ut som en serveradress. Använd https://-adressen från konsolen.',
  code: 'Anspråkskod',
  codePlaceholder: 'XXXX-XXXX-XXXX-XXXX',
  codeHint: '16 bokstäver och siffror. Stora eller små bokstäver, mellanslag och bindestreck spelar ingen roll.',
  badCode: 'En anspråkskod har 16 bokstäver och siffror, till exempel 7KQ2-ZM8P-X4TD-9HRA.',
  check: 'Kontrollera',
  checking: 'Kontrollerar servern…',
  found: 'Det här är din server. Vill du gå med som ägare?',
  join: 'Gå med som ägare',
  back: 'Ändra',
  errors: {
    unreachable: 'Servern svarade inte. Kontrollera adressen, och ge en helt ny server några minuter att starta och skaffa sitt certifikat.',
    noClaim: 'Den här servern väntar inte på något anspråk: den har redan en ägare, eller så gick koden ut efter 24 timmar. Starta om servern för att få en ny kod (i konsolen: sudo systemctl restart iskra) och titta igen.',
    wrongCode: 'Koden stämmer inte med den här servern. Jämför varje tecken med konsolen.',
    busy: 'För många försök härifrån. Vänta en minut och försök igen.',
  },
  note: 'Koden stannar på den här enheten: appen kontrollerar bara serverns bevis på att den har samma kod. Den fungerar en gång, i 24 timmar.',
}
