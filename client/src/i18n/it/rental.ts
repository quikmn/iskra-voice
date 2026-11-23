import type { Messages } from '../types'

export const rental: Messages['rental'] = {
  title: 'Noleggia un server su DigitalOcean',
  entry: {
    title: "Oppure lascia fare all'app, su DigitalOcean",
    text: "L'app desktop può noleggiare e configurare il server per te nel tuo account DigitalOcean: un solo pulsante, circa 6 $ al mese pagati a DigitalOcean.",
    button: 'Noleggia su DigitalOcean',
  },
  createLink: 'Vuoi un server che resti acceso anche quando questo computer è spento?',
  createButton: 'Noleggiane uno su DigitalOcean',
  steps: {
    label: 'Passaggi',
    account: 'Account',
    token: 'Accesso',
    place: 'Server',
    create: 'Configurazione',
  },
  account: {
    heading: 'Un account DigitalOcean',
    intro: "Il tuo server gira presso DigitalOcean, un'azienda di hosting, sempre acceso, così gli amici possono entrare anche quando il tuo computer è spento. Ti serve un account lì; al resto pensa l'app.",
    cost: 'Circa <b>6 $ al mese</b> per il loro server più piccolo adatto a Iskra (1 GB di memoria), fatturato a ore. Vedi il prezzo esatto prima che venga creato qualcosa. Iskra è gratuita e non chiede nulla.',
    credit: 'I nuovi account DigitalOcean ricevono un credito di benvenuto, quindi i primi mesi potrebbero non costarti nulla.',
    referral: "Iskra ti manda su DigitalOcean con il nostro link referral: Iskra riceve un po' di credito DigitalOcean che aiuta a pagare il nostro server. Paghi direttamente DigitalOcean; noi non vediamo mai il tuo server né la tua carta.",
    open: 'Apri DigitalOcean',
    have: 'Ho già un account',
  },
  connect: {
    heading: 'Collega Iskra a DigitalOcean',
    intro: "Accedi a DigitalOcean nel browser e consenti a Iskra di creare un server per te. L'app riceve una chiave che vale un'ora, la tiene solo in memoria e la dimentica a configurazione finita.",
    button: 'Collega a DigitalOcean',
    waiting: 'Ti aspettiamo nel browser…',
    cancel: 'Annulla',
    fallback: 'Usa invece un token API',
  },
  token: {
    heading: "Lascia che l'app lo configuri",
    intro: "Crea una chiave (un «personal access token») che permette a questa app di creare il server per te. Resta nella memoria dell'app su questo computer, va solo a DigitalOcean e viene buttata via a configurazione finita.",
    step1: 'In DigitalOcean, apri <tokens>API → Tokens</tokens> e premi <b>Generate New Token</b>.',
    step2: 'Chiamalo «Iskra setup» e scegli la <b>Expiration</b> più breve (30 giorni, oppure Custom per un giorno).',
    step3: 'In <b>Scopes</b>, scegli <b>Custom Scopes</b> e spunta solo: <b>droplet</b> (create, read, delete), <b>firewall</b> (create, read, delete), <b>regions</b> (read), <b>sizes</b> (read) e <b>tag</b> (create). DigitalOcean potrebbe spuntare da solo qualche scope di lettura collegato; va bene così.',
    step4: 'Premi <b>Generate Token</b>, copialo (inizia con dop_v1_) e incollalo qui.',
    label: 'Token',
    placeholder: 'dop_v1_…',
    next: 'Continua',
    checking: 'Verifica con DigitalOcean…',
    back: 'Indietro',
  },
  place: {
    heading: 'Il tuo server',
    region: 'Località',
    regionHint: "Scegli quella più vicina al tuo gruppo, così il vocale è reattivo. L'app ha fatto una stima dal tuo fuso orario.",
    regionOption: '{{name}}: {{price}} al mese',
    name: 'Nome del server',
    template: 'Punto di partenza',
    size: '{{memory}} di memoria, {{vcpus}} CPU, {{disk}} GB di disco, Ubuntu 24.04. <b>{{price}} al mese</b>, fatturati a ore da DigitalOcean.',
    ssh: 'Consenti anche SSH (accesso da terminale)',
    sshHint: 'Disattivo di norma: per usare Iskra nessuno deve accedere al server, quindi il firewall lascia entrare solo web e vocale. Puoi aprirlo più tardi in DigitalOcean.',
    note: 'Vengono creati un server (un «droplet») e un firewall nel tuo account DigitalOcean. Non viene creato nulla prima che tu prema il pulsante.',
    create: 'Crea il server a {{price}} al mese',
  },
  progress: {
    heading: 'Configurazione di {{name}}',
    droplet: 'Creazione del server su DigitalOcean',
    firewall: 'Aggiunta di un firewall (solo web e vocale)',
    booting: 'Avvio del server',
    installing: 'Installazione di Iskra e richiesta del certificato HTTPS (di solito 3–10 minuti)',
    claiming: 'Ti stiamo rendendo proprietario',
    keepOpen: 'Lascia aperta questa finestra; intanto puoi continuare a chattare.',
    address: 'Indirizzo: {{url}}',
    stop: 'Ferma',
  },
  stopAsk: {
    heading: 'Fermare la configurazione?',
    text: 'Il server esiste già nel tuo account DigitalOcean e costa finché esiste.',
    delete: 'Ferma ed eliminalo',
    keep: 'Tienilo',
    back: 'Continua',
    kept: 'Conservato. È nel tuo account DigitalOcean (<droplets>Droplets</droplets>); se non lo vuoi, eliminalo lì. Per completare più tardi, apri Noleggia un piccolo server e connettiti a {{ip}}.',
  },
  failed: {
    heading: 'Non ha funzionato',
    created: 'Nel tuo account DigitalOcean è già stato creato un server. Costa finché esiste.',
    cleanUp: 'Eliminalo su DigitalOcean',
    cleaning: 'Eliminazione…',
    cleaned: 'Eliminato. Nel tuo account DigitalOcean non resta nulla di questo tentativo.',
    cleanFailed: 'Impossibile eliminarlo da qui. Eliminalo tu in DigitalOcean: il server in <droplets>Droplets</droplets>, il firewall in <firewalls>Networking → Firewalls</firewalls>.',
    keepWaiting: 'Continua ad aspettare',
    retry: 'Riprova',
    detail: 'DigitalOcean ha risposto: {{detail}}',
  },
  errors: {
    token: 'DigitalOcean non ha accettato quel token. Controlla di averlo copiato tutto e che non sia scaduto.',
    scope: 'A Iskra manca un permesso su DigitalOcean. Collega di nuovo e consenti tutto quello che chiede, oppure crea un nuovo token con gli scope indicati nei passaggi del token.',
    limit: 'Il tuo account DigitalOcean non può ancora avere un altro server (i nuovi account partono con un limite). Chiedi a DigitalOcean di alzarlo, oppure elimina un server che non usi.',
    rate: 'DigitalOcean ci chiede di rallentare. Aspetta un minuto e riprova.',
    network: 'Impossibile raggiungere DigitalOcean. Controlla la connessione a internet e riprova.',
    server: 'DigitalOcean ha avuto un problema. Riprova tra qualche minuto.',
    invalid: 'DigitalOcean ha rifiutato quella richiesta.',
    timeoutBoot: 'Il server non si è avviato entro 5 minuti.',
    timeoutInstall: "Il tuo server non ha risposto via HTTPS entro 25 minuti. Forse sta ancora completando l'installazione o aspetta il certificato.",
    cancelled: 'Fermato.',
    busy: 'È già in corso la configurazione di un server.',
    denied: "DigitalOcean non ha dato l'accesso a Iskra. Riprova, oppure usa invece un token API.",
    unavailable: "Aggiorna l'app desktop per noleggiare un server da qui.",
  },
  done: {
    heading: 'Il tuo server è pronto',
    text: 'Il server {{name}} è tuo. I backup giornalieri e gli aggiornamenti automatici sono attivi.',
    address: 'Indirizzo',
    cost: 'Costo',
    costValue: '{{price}} al mese su DigitalOcean',
    save: 'Salva il documento del tuo server',
    saved: 'Salvato',
    saveHint: 'Tutto sul tuo server in un unico file: come invitare gli amici, i costi e come disdire, gli aggiornamenti, i backup, il trasferimento e un prompt per un assistente IA. Non contiene password né chiavi.',
    tokenGone: 'Il token non è più in questa app. Puoi eliminarlo anche in DigitalOcean (<tokens>API → Tokens</tokens>).',
    close: 'Vai al mio server',
  },
  doc: {
    fileName: 'Server Iskra - {{name}}.md',
    title: '{{name}}: il tuo server Iskra',
    made: "Creato dall'app Iskra il {{date}}. Conserva questo file. Non contiene password né chiavi.",
    addressTitle: 'Indirizzo',
    address:
      '- Indirizzo: {{url}}\n' +
      '- Indirizzo IP: {{ip}}\n' +
      '- Su DigitalOcean: il droplet "{{droplet}}" in {{region}} ({{size}}), con il firewall "{{droplet}}-firewall".',
    joinTitle: 'Come entrano gli amici',
    join: "Apri il server in Iskra e premi **Invita amici**: crea un link da inviare loro. Lo aprono nell'app Iskra o in un browser. Decidi tu chi entra: i link possono scadere o funzionare una volta sola, e i ruoli stabiliscono cosa possono fare le persone.",
    keysTitle: 'Le tue chiavi e il recupero',
    keys:
      '- Il proprietario sei tu. Il tuo account vive sui tuoi dispositivi, non sul server. Conserva la tua **chiave di recupero** (Le mie impostazioni → Chiave di recupero) in un posto sicuro: ti restituisce il tuo account su un nuovo dispositivo.\n' +
      '- La chiave e i dati del server si trovano sul server in /opt/iskra/world (server.key, iskra.db, uploads/). I backup giornalieri sono in /opt/iskra/world/backups.\n' +
      "- Gli strumenti da proprietario sono nell'app: Impostazioni del server (membri, ruoli, backup, aggiornamenti).",
    costTitle: 'Quanto costa, e come disdire',
    cost:
      '- {{price}} al mese, fatturati a ore da DigitalOcean. Li vedi in Billing: {{billing}}. Iskra non chiede nulla.\n' +
      '- Per smettere di pagare: in DigitalOcean apri Droplets ({{droplets}}), scegli "{{droplet}}", poi Destroy → Destroy this Droplet. Un droplet soltanto spento continua a costare; distruggerlo ferma i costi. Poi elimina il firewall "{{droplet}}-firewall" in Networking → Firewalls (è gratuito, ma così resta in ordine).\n' +
      '- Vuoi conservare la cronologia del tuo server? Prima fai un backup (Impostazioni del server → Backup e trasferimento).',
    updatesTitle: 'Aggiornamenti e backup',
    updates:
      '- Iskra si aggiorna da sola alle nuove versioni di notte (intorno alle 04:00, ora del server, con verifica dei checksum pubblicati). Impostazioni del server → Aggiornamenti del server mostra la versione e ti permette di cambiare questa impostazione.\n' +
      '- Ubuntu installa da solo i propri aggiornamenti di sicurezza.\n' +
      '- Ogni giorno viene creato un backup sul server (si conservano gli ultimi 7). Dato che stanno sullo stesso server, ogni tanto scaricane anche uno: Impostazioni del server → Backup e trasferimento → Crea backup (crittografato con una frase segreta scelta da te). I backup a pagamento di DigitalOcean sono disattivati.',
    moveTitle: 'Trasferirlo in futuro',
    move: "Tutto il tuo server è una cartella. Fai un backup in Impostazioni del server → Backup e trasferimento, ripristinalo sul nuovo computer o server (app desktop: Crea un server → Ripristina da un backup), poi usa **Trasferisci questo server** così l'app di tutti segue il nuovo indirizzo. Guida: {{guide}}",
    seesTitle: 'Cosa può e non può vedere Iskra',
    sees:
      "Il progetto Iskra non gestisce nulla per il tuo server e non vede nulla: né il tuo server, né i tuoi messaggi, né il tuo account DigitalOcean, né il tuo token, né la tua carta. L'app ha parlato con DigitalOcean solo durante la configurazione, con il tuo token, e l'ha dimenticato. " +
      'DigitalOcean, come qualsiasi azienda di hosting, tecnicamente potrebbe leggere il disco del server; i messaggi diretti e i canali crittografati hanno la crittografia end-to-end, quindi quelli non può leggerli. ' +
      "Il tuo server parla con GitHub (aggiornamenti) e con Let's Encrypt (il suo certificato), e i name server di sslip.io rispondono per il suo indirizzo.",
    aiTitle: 'Aiuto da un assistente IA',
    aiIntro: 'Se qualcosa va storto, incolla il testo qui sotto in un assistente IA (Claude, ChatGPT…). Descrive esattamente la tua configurazione e non contiene segreti.',
    sshOpen: 'SSH (22/tcp) è consentito',
    sshClosed: 'SSH (22/tcp) non è consentito; per usare SSH o la Droplet Console, prima aggiungi a quel firewall una regola in entrata per TCP 22',
    ai:
      "Gestisco un server Iskra (un server vocale e di chat self-hosted, https://github.com/quikmn/iskra-voice) su un droplet DigitalOcean. Aiutami con un problema. Chiedimi di eseguire dei comandi e di incollarne l'output, e prima spiegami ogni comando. Ecco esattamente com'è stato configurato:\n\n" +
      '- Droplet "{{droplet}}" nella regione {{region}}, dimensione {{size}}, immagine Ubuntu 24.04 LTS (x86-64), IPv4 pubblico {{ip}}.\n' +
      '- Configurato al primo avvio da uno script cloud-init user-data (log: /var/log/iskra-setup.log). Ha installato Iskra {{version}} dalle release di GitHub (iskra-server-{{version}}-linux-x64.tar.gz, verificato con SHA256SUMS.txt).\n' +
      '- Programma in /opt/iskra; dati ("world") in /opt/iskra/world: server.json (impostazioni), iskra.db (SQLite), server.key, uploads/, backups/, certs/. Tutto appartiene all\'utente di sistema "iskra".\n' +
      '- Il servizio systemd "iskra" (/etc/systemd/system/iskra.service) esegue "/opt/iskra/iskra-server /opt/iskra/world" come utente iskra, con ExecStartPre=-/opt/iskra/iskra-update-guard e AmbientCapabilities=CAP_NET_BIND_SERVICE. Il vocale è LiveKit, che il server avvia da solo.\n' +
      '- Indirizzo {{url}} (un nome sslip.io per l\'IP). Il server ottiene da solo il certificato HTTPS da Let\'s Encrypt (server.json "Https": {"Mode": "acme"}).\n' +
      '- Porte: 80/tcp (controllo del certificato), 443/tcp (web e WebSocket), 7881/tcp e 7882/udp (vocale). Aperte in ufw sul droplet (con 22/tcp) e nel cloud firewall di DigitalOcean "{{droplet}}-firewall": {{ssh}}.\n' +
      '- Aggiornamenti automatici dalle release di GitHub (server.json "Updates": {"Mode": "auto"}) e backup giornalieri in /opt/iskra/world/backups.\n' +
      '- Log: journalctl -u iskra -n 200 --no-pager. Stato: systemctl status iskra. Health: curl -s {{url}}/health\n' +
      '- Guida: https://iskra.foo/docs/hosting\n\n' +
      'Il mio problema: <descrivilo qui>',
  },
}
