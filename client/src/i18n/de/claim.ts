import type { Messages } from '../types'

export const claim: Messages['claim'] = {
  title: 'Server übernehmen',
  entry: 'Du hast einen Server bei DigitalOcean oder auf deinem eigenen Rechner erstellt und er zeigt einen Übernahmecode? <a>Übernimm ihn</a>.',
  intro: 'Ein neuer Iskra-Server aus dem DigitalOcean Marketplace zeigt seine Adresse und einen Übernahmecode auf seiner Konsole (DigitalOcean: dein Droplet → Console). Gib beides hier ein, um sein Besitzer zu werden.',
  address: 'Serveradresse',
  addressPlaceholder: 'https://203-0-113-7.sslip.io',
  addressHint: 'Wie auf der Konsole angezeigt. Eine IP-Adresse geht auch.',
  badAddress: 'Das sieht nicht nach einer Serveradresse aus. Nimm die https://-Adresse von der Konsole.',
  code: 'Übernahmecode',
  codePlaceholder: 'XXXX-XXXX-XXXX-XXXX',
  codeHint: '16 Buchstaben und Ziffern. Großschreibung, Leerzeichen und Bindestriche sind egal.',
  badCode: 'Ein Übernahmecode hat 16 Buchstaben und Ziffern, wie 7KQ2-ZM8P-X4TD-9HRA.',
  check: 'Prüfen',
  checking: 'Server wird geprüft…',
  found: 'Das ist dein Server. Als Besitzer beitreten?',
  join: 'Als Besitzer beitreten',
  back: 'Ändern',
  errors: {
    unreachable: 'Der Server hat nicht geantwortet. Prüfe die Adresse und gib einem ganz neuen Server ein paar Minuten, um zu starten und sein Zertifikat zu holen.',
    noClaim: 'Dieser Server wartet nicht auf eine Übernahme: Er hat schon einen Besitzer, oder sein Code ist nach 24 Stunden abgelaufen. Für einen neuen Code starte den Server neu (auf der Konsole: sudo systemctl restart iskra) und sieh nochmal nach.',
    wrongCode: 'Der Code passt nicht zu diesem Server. Vergleiche jeden Buchstaben mit der Konsole.',
    busy: 'Zu viele Versuche von hier. Warte eine Minute und versuch es nochmal.',
  },
  note: 'Der Code bleibt auf diesem Gerät: Die App prüft nur den Beweis des Servers, dass er denselben Code hat. Er gilt einmal, 24 Stunden lang.',
}
