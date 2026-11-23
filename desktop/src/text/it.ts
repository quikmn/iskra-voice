// Italiano. Same keys as ./en; the compiler flags anything missing or extra.
import type { DesktopText } from './en'

export const text: DesktopText = {
  tray: {
    open: 'Apri Iskra',
    about: 'Informazioni su Iskra',
    check: 'Controlla aggiornamenti',
    checking: 'Controllo degli aggiornamenti…',
    downloading: (version: string) => `Download di ${version}…`,
    restart: (version: string) => `Riavvia per aggiornare alla ${version}`,
    download: (version: string) => `Scarica Iskra ${version}`,
    quit: 'Chiudi Iskra',
  },
  updates: {
    titleReady: 'Aggiornamento pronto',
    titleAvailable: 'Aggiornamento disponibile',
  },
  menu: { view: 'Vista' },
  recordings: {
    pickTitle: 'Dove vuoi salvare le registrazioni delle chiamate?',
  },
  backup: {
    pickTitle: 'Ripristina un server da un backup',
    filter: 'Backup di Iskra',
    notBackup: 'Quel file non è un backup di Iskra.',
  },
  bots: {
    pickTitle: 'Scegli un bot di cui ti fidi',
    pickMessage: 'Avvia solo bot di cui ti fidi: un bot gira con i tuoi diritti su questo computer e può leggere e modificare i tuoi file.',
    pickButton: 'Usa questa cartella',
    warnTitle: 'Avvia solo bot di cui ti fidi',
    runQuestion: (name: string) => `Avviare «${name}» su questo computer?`,
    autostartQuestion: (name: string) => `Avviare «${name}» ogni volta che Iskra si avvia?`,
    changedQuestion: (name: string) => `«${name}» è cambiato dall'ultima volta che l'hai avviato. Avviarlo comunque?`,
    warnDetail: (folder: string) => `${folder}

Questo bot gira con i tuoi diritti su questo computer: può leggere e modificare i tuoi file. Avvia solo bot di cui ti fidi.`,
    run: 'Avvia',
    autostart: 'Avvia con Iskra',
    cancel: 'Annulla',
  },
  template: {
    pickTitle: 'Avvia un server da un file modello',
    filter: 'Modelli di Iskra',
    tooBig: 'Quel file è troppo grande per essere un modello.',
  },
  host: {
    defaultName: 'Il mio server',
    noServer: 'Questa build non include il server.',
    stoppedEarly: "Il server si è fermato subito dopo l'avvio. La sua porta è già in uso?",
    damaged: 'I file del server sono danneggiati, quindi non può avviarsi. Il file server.log nella sua cartella dice cosa non va; il ripristino di un backup risolve il problema.',
    couldntStart: (error: string) => `Impossibile avviare il server: ${error}`,
    couldntRun: (error: string) => `Impossibile eseguire il server: ${error}`,
    restoreFailed: 'Impossibile ripristinare il backup.',
    noPort: 'Nessuna porta libera trovata.',
  },
  keys: {
    mouse: (button: number) => `Mouse ${button}`,
    key: (code: number) => `Tasto ${code}`,
  },
  passkey: {
    title: 'Passkey di Iskra',
    waiting: 'Segui la richiesta del tuo dispositivo o della chiave di sicurezza.',
  },
  splash: {
    title: 'Iskra',
    starting: 'Avvio di Iskra…',
    servers: 'Avvio dei tuoi server…',
    connecting: 'Connessione…',
    ready: 'Pronto',
    updatedTo: (version: string) => `Aggiornata alla ${version}`,
    updating: (version: string) => `Aggiornamento di Iskra alla ${version}…`,
    updatingDetail: 'Torna tra pochi secondi.',
  },
  assistant: {
    title: 'Assistente di Iskra',
    question: (host: string) => `Consentire all'assistente di inviare le tue domande a ${host}?`,
    detail: "Rispondi di sì solo se hai inserito tu questo indirizzo in Le mie impostazioni → Assistente. Quello che chiedi all'assistente, e quello che legge per te, andrà lì.",
    yes: 'Sì, usalo',
    no: 'No',
  },
  digitalOcean: {
    done: 'Collegato a DigitalOcean. Puoi chiudere questa scheda e tornare a Iskra.',
    denied: 'Iskra non è stata collegata a DigitalOcean. Puoi chiudere questa scheda e tornare a Iskra.',
  },
}
