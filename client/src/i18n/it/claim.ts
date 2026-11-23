import type { Messages } from '../types'

export const claim: Messages['claim'] = {
  title: 'Rivendica un server',
  entry: 'Hai creato un server su DigitalOcean o su una tua macchina e mostra un codice di rivendicazione? <a>Rivendicalo</a>.',
  intro: 'Un nuovo server Iskra creato dal Marketplace di DigitalOcean mostra il suo indirizzo e un codice di rivendicazione nella console (DigitalOcean: il tuo droplet → Console). Inseriscili qui per diventarne proprietario.',
  address: 'Indirizzo del server',
  addressPlaceholder: 'https://203-0-113-7.sslip.io',
  addressHint: 'Come mostrato nella console. Va bene anche un indirizzo IP.',
  badAddress: "Non sembra l'indirizzo di un server. Usa l'indirizzo https:// mostrato nella console.",
  code: 'Codice di rivendicazione',
  codePlaceholder: 'XXXX-XXXX-XXXX-XXXX',
  codeHint: '16 lettere e cifre. Maiuscole, spazi e trattini non contano.',
  badCode: 'Un codice di rivendicazione ha 16 lettere e cifre, come 7KQ2-ZM8P-X4TD-9HRA.',
  check: 'Controlla',
  checking: 'Controllo del server…',
  found: 'Questo è il tuo server. Vuoi entrare come proprietario?',
  join: 'Entra come proprietario',
  back: 'Cambia',
  errors: {
    unreachable: "Il server non ha risposto. Controlla l'indirizzo, e a un server appena creato lascia qualche minuto per avviarsi e ottenere il certificato.",
    noClaim: 'Questo server non aspetta una rivendicazione: ha già un proprietario, oppure il suo codice è scaduto dopo 24 ore. Per avere un nuovo codice, riavvia il server (nella console: sudo systemctl restart iskra) e guarda di nuovo.',
    wrongCode: 'Quel codice non corrisponde a questo server. Confronta ogni lettera con la console.',
    busy: 'Troppi tentativi da qui. Aspetta un minuto e riprova.',
  },
  note: "Il codice resta su questo dispositivo: l'app controlla solo la prova che il server ha lo stesso codice. Funziona una volta sola, per 24 ore.",
}
