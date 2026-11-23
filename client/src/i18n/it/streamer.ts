import type { Messages } from '../types'

export const streamer: Messages['streamer'] = {
  title: 'Modalità streamer',
  pill: 'Modalità streamer',
  pillHint: "La modalità streamer è attiva: link d'invito, ID e anteprime sono nascosti, e le notifiche sono silenziose. Disattivala in Le mie impostazioni o dal menu del tuo stato.",
  switch: 'Modalità streamer',
  switchHint: "Per quando il tuo schermo è in diretta: nasconde link e codici d'invito, ID degli account e codici di sicurezza, indirizzi email nei profili e anteprime dei messaggi, e tiene silenziosi notifiche e suoni. Segue il tuo account sugli altri tuoi dispositivi.",
  on: 'Attiva',
  off: 'Disattiva',
  autoTitle: 'Attivazione automatica',
  auto: 'Mentre è in esecuzione un programma del mio elenco qui sotto',
  autoHint: "Aggiungi OBS, Streamlabs o quello che usi per le dirette all'elenco dei programmi: la modalità streamer si attiva da sola mentre è in esecuzione e si disattiva quando lo chiudi. Solo su questo computer, e vengono cercati solo i programmi che hai aggiunto.",
  autoNow: 'Un programma del tuo elenco è in esecuzione: la modalità streamer è attiva.',
  autoDesktopOnly: "L'app desktop può anche attivarla da sola mentre è in esecuzione il tuo programma per le dirette:",
  hidden: 'Nascosto in modalità streamer',
  hiddenShort: 'Nascosto',
  menu: {
    on: 'La modalità streamer è attiva',
    off: 'Modalità streamer',
    turnOff: 'Disattiva',
    turnOn: 'Attiva',
    autoOn: 'Attiva mentre è in esecuzione il tuo programma per le dirette',
  },
}
