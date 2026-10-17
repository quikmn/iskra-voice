import type { Messages } from '../types'

export const rental: Messages['rental'] = {
  title: 'Hyr en server hos DigitalOcean',
  entry: {
    title: 'Eller låt appen göra det, hos DigitalOcean',
    text: 'Skrivbordsappen kan hyra och sätta upp servern åt dig i ditt eget DigitalOcean-konto: en knapp, ungefär 6 dollar i månaden som du betalar till DigitalOcean.',
    button: 'Hyr hos DigitalOcean',
  },
  createLink: 'Vill du ha en server som är igång även när den här datorn är avstängd?',
  createButton: 'Hyr en hos DigitalOcean',
  steps: {
    label: 'Steg',
    account: 'Konto',
    token: 'Åtkomst',
    place: 'Server',
    create: 'Uppsättning',
  },
  account: {
    heading: 'Ett konto hos DigitalOcean',
    intro: 'Din server körs hos DigitalOcean, ett hostingföretag, dygnet runt, så att vänner kan ansluta även när din dator är avstängd. Du behöver ett konto där; appen gör resten.',
    cost: 'Ungefär <b>6 dollar i månaden</b> för deras minsta server som räcker för Iskra (1 GB minne), debiterat per timme. Du ser det exakta priset innan något skapas. Iskra är gratis och tar inget betalt.',
    credit: 'Nya konton hos DigitalOcean får startkredit, så de första månaderna kan bli gratis.',
    referral: 'Iskra skickar dig till DigitalOcean med vår värvningslänk: Iskra får lite kredit hos DigitalOcean som hjälper till att betala för vår egen server. Du betalar DigitalOcean direkt; vi ser aldrig din server eller ditt kort.',
    open: 'Öppna DigitalOcean',
    have: 'Jag har ett konto',
  },
  connect: {
    heading: 'Anslut Iskra till DigitalOcean',
    intro: 'Logga in hos DigitalOcean i webbläsaren och låt Iskra skapa en server åt dig. Appen får en nyckel som fungerar i en timme, håller den bara i minnet och glömmer den när uppsättningen är klar.',
    button: 'Anslut till DigitalOcean',
    waiting: 'Väntar på dig i webbläsaren…',
    cancel: 'Avbryt',
    fallback: 'Använd en API-token i stället',
  },
  token: {
    heading: 'Låt appen sätta upp den',
    intro: 'Skapa en nyckel (en "personal access token") som låter appen skapa servern åt dig. Den stannar i appens minne på den här datorn, skickas bara till DigitalOcean och slängs när uppsättningen är klar.',
    step1: 'Öppna <tokens>API → Tokens</tokens> hos DigitalOcean och tryck på <b>Generate New Token</b>.',
    step2: 'Döp den till "Iskra setup" och välj kortast möjliga <b>Expiration</b> (30 dagar, eller Custom för en dag).',
    step3: 'Under <b>Scopes</b> väljer du <b>Custom Scopes</b> och kryssar bara i: <b>droplet</b> (create, read, delete), <b>firewall</b> (create, read, delete), <b>regions</b> (read), <b>sizes</b> (read) och <b>tag</b> (create). DigitalOcean kan kryssa i några närliggande läsbehörigheter själv; det är okej.',
    step4: 'Tryck på <b>Generate Token</b>, kopiera den (den börjar med dop_v1_) och klistra in den här.',
    label: 'Token',
    placeholder: 'dop_v1_…',
    next: 'Fortsätt',
    checking: 'Kollar med DigitalOcean…',
    back: 'Tillbaka',
  },
  place: {
    heading: 'Din server',
    region: 'Plats',
    regionHint: 'Välj den som ligger närmast din grupp, så känns rösten snabb. Appen gissade utifrån din tidszon.',
    regionOption: '{{name}}: {{price}} i månaden',
    name: 'Serverns namn',
    template: 'Utgångsläge',
    size: '{{memory}} minne, {{vcpus}} CPU, {{disk}} GB disk, Ubuntu 24.04. <b>{{price}} i månaden</b>, debiterat av DigitalOcean per timme.',
    ssh: 'Tillåt även SSH (terminalåtkomst)',
    sshHint: 'Av från början: ingen behöver logga in för att köra Iskra, så brandväggen släpper bara in webb och röst. Du kan öppna den senare hos DigitalOcean.',
    note: 'Det här skapar en server (en "droplet") och en brandvägg i ditt DigitalOcean-konto. Inget skapas innan du trycker på knappen.',
    create: 'Skapa server för {{price}} i månaden',
  },
  progress: {
    heading: 'Sätter upp {{name}}',
    droplet: 'Skapar servern hos DigitalOcean',
    firewall: 'Lägger till en brandvägg (bara webb och röst)',
    booting: 'Startar den',
    installing: 'Installerar Iskra och hämtar HTTPS-certifikatet (brukar ta 3–10 minuter)',
    claiming: 'Gör dig till ägare',
    keepOpen: 'Låt fönstret vara öppet; du kan chatta under tiden.',
    address: 'Adress: {{url}}',
    stop: 'Avbryt',
  },
  stopAsk: {
    heading: 'Avbryta uppsättningen?',
    text: 'Servern finns redan i ditt DigitalOcean-konto och kostar pengar så länge den finns.',
    delete: 'Avbryt och ta bort den',
    keep: 'Behåll den',
    back: 'Fortsätt',
    kept: 'Behållen. Den finns i ditt DigitalOcean-konto (<droplets>Droplets</droplets>); ta bort den där om du inte vill ha den. Vill du slutföra senare öppnar du Hyr en liten server och ansluter till {{ip}}.',
  },
  failed: {
    heading: 'Det gick inte',
    created: 'En server hann skapas i ditt DigitalOcean-konto. Den kostar pengar så länge den finns.',
    cleanUp: 'Ta bort den hos DigitalOcean',
    cleaning: 'Tar bort…',
    cleaned: 'Borttagen. Inget från det här försöket finns kvar i ditt DigitalOcean-konto.',
    cleanFailed: 'Det gick inte att ta bort den härifrån. Ta bort den själv hos DigitalOcean: servern under <droplets>Droplets</droplets>, brandväggen under <firewalls>Networking → Firewalls</firewalls>.',
    keepWaiting: 'Vänta lite till',
    retry: 'Försök igen',
    detail: 'DigitalOcean svarade: {{detail}}',
  },
  errors: {
    token: 'DigitalOcean godtog inte den token. Kolla att du kopierade hela och att den inte har gått ut.',
    scope: 'Iskra saknar en behörighet hos DigitalOcean. Anslut igen och tillåt allt den ber om, eller skapa en ny token med behörigheterna i token-stegen.',
    limit: 'Ditt DigitalOcean-konto får inte ha fler servrar än (nya konton har en gräns). Be DigitalOcean höja den, eller ta bort en server du inte använder.',
    rate: 'DigitalOcean ber oss ta det lugnt. Vänta en minut och försök igen.',
    network: 'Når inte DigitalOcean. Kolla din internetanslutning och försök igen.',
    server: 'DigitalOcean fick problem. Försök igen om några minuter.',
    invalid: 'DigitalOcean sa nej till det.',
    timeoutBoot: 'Servern startade inte inom 5 minuter.',
    timeoutInstall: 'Din server svarade inte över HTTPS inom 25 minuter. Den kanske fortfarande installeras eller väntar på sitt certifikat.',
    cancelled: 'Avbrutet.',
    busy: 'En server håller redan på att sättas upp.',
    denied: 'DigitalOcean gav inte Iskra åtkomst. Försök igen, eller använd en API-token i stället.',
    unavailable: 'Uppdatera skrivbordsappen för att hyra en server härifrån.',
  },
  done: {
    heading: 'Din server är klar',
    text: 'Du är ägare till {{name}}. Dagliga säkerhetskopior och automatiska uppdateringar är på.',
    address: 'Adress',
    cost: 'Kostnad',
    costValue: '{{price}} i månaden hos DigitalOcean',
    save: 'Spara ditt serverdokument',
    saved: 'Sparat',
    saveHint: 'Allt om din server i en fil: bjuda in vänner, kostnad och hur du säger upp, uppdateringar, säkerhetskopior, flytt och en prompt till en AI-assistent. Inga lösenord eller nycklar.',
    tokenGone: 'Din token är borta ur appen. Du kan ta bort den hos DigitalOcean också (<tokens>API → Tokens</tokens>).',
    close: 'Gå till min server',
  },
  doc: {
    fileName: 'Iskra-server - {{name}}.md',
    title: '{{name}}: din Iskra-server',
    made: 'Skapat av Iskra-appen {{date}}. Spara filen. Den innehåller inga lösenord eller nycklar.',
    addressTitle: 'Adress',
    address:
      '- Adress: {{url}}\n' +
      '- IP-adress: {{ip}}\n' +
      '- Hos DigitalOcean: dropleten "{{droplet}}" i {{region}} ({{size}}), med brandväggen "{{droplet}}-firewall".',
    joinTitle: 'Så ansluter vänner',
    join: 'Öppna servern i Iskra och tryck på **Bjud in vänner**: du får en länk att skicka. De öppnar den i Iskra-appen eller i en webbläsare. Du bestämmer vem som kommer in: länkar kan gå ut eller bara fungera en gång, och roller bestämmer vad folk får göra.',
    keysTitle: 'Dina nycklar och återställning',
    keys:
      '- Du är ägare. Ditt konto finns på dina egna enheter, inte på servern. Spara din **återställningsnyckel** (Mina inställningar → Återställningsnyckel) på ett säkert ställe: med den får du tillbaka kontot på en ny enhet.\n' +
      '- Serverns egen nyckel och data finns på servern i /opt/iskra/world (server.key, iskra.db, uploads/). Dagliga säkerhetskopior finns i /opt/iskra/world/backups.\n' +
      '- Ägarverktygen finns i appen: Serverinställningar (medlemmar, roller, säkerhetskopior, uppdateringar).',
    costTitle: 'Vad det kostar och hur du säger upp',
    cost:
      '- {{price}} i månaden, debiterat av DigitalOcean per timme. Du ser det under Billing: {{billing}}. Iskra tar inget betalt.\n' +
      '- Så slutar du betala: öppna Droplets hos DigitalOcean ({{droplets}}), välj "{{droplet}}" och sedan Destroy → Destroy this Droplet. En droplet som bara är avstängd kostar fortfarande; först när den förstörs slutar det. Ta sedan bort brandväggen "{{droplet}}-firewall" under Networking → Firewalls (gratis, men snyggare).\n' +
      '- Vill du behålla serverns historik? Gör en säkerhetskopia först (Serverinställningar → Säkerhetskopia och flytt).',
    updatesTitle: 'Uppdateringar och säkerhetskopior',
    updates:
      '- Iskra uppdaterar sig själv till nya versioner på natten (runt 04:00 serverns tid, kontrollerat mot de publicerade kontrollsummorna). Serverinställningar → Serveruppdateringar visar versionen och låter dig ändra det.\n' +
      '- Ubuntu installerar sina egna säkerhetsuppdateringar själv.\n' +
      '- En säkerhetskopia görs varje dag på servern (de senaste 7 sparas). Eftersom de ligger på samma server bör du ladda ner en ibland också: Serverinställningar → Säkerhetskopia och flytt → Gör säkerhetskopia (krypterad med en lösenfras du väljer). DigitalOceans egna betalda säkerhetskopior är av.',
    moveTitle: 'Flytta den senare',
    move: 'Hela din server är en mapp. Gör en säkerhetskopia i Serverinställningar → Säkerhetskopia och flytt, återställ den på den nya datorn eller servern (skrivbordsappen: Skapa en server → Återställ från en säkerhetskopia) och använd sedan **Flytta den här servern** så att allas appar följer med till den nya adressen. Guide: {{guide}}',
    seesTitle: 'Vad Iskra kan och inte kan se',
    sees:
      'Iskra-projektet kör ingenting åt din server och ser ingenting: inte din server, dina meddelanden, ditt DigitalOcean-konto, din token eller ditt kort. Appen pratade med DigitalOcean bara under uppsättningen, med din token, och har glömt den. ' +
      'DigitalOcean kan, som alla hostingföretag, tekniskt sett läsa serverns disk; direktmeddelanden och krypterade kanaler är totalsträckskrypterade, så dem kan de inte läsa. ' +
      'Din server pratar själv med GitHub (uppdateringar) och Let’s Encrypt (certifikatet), och sslip.io:s namnservrar svarar för dess adress.',
    aiTitle: 'Hjälp från en AI-assistent',
    aiIntro: 'Om något strular kan du klistra in texten nedan i en AI-assistent (Claude, ChatGPT…). Den beskriver din uppsättning exakt och innehåller inga hemligheter.',
    sshOpen: 'SSH (22/tcp) är tillåtet',
    sshClosed: 'SSH (22/tcp) är inte tillåtet; för att använda SSH eller Droplet Console måste du först lägga till en inkommande regel för TCP 22 i den brandväggen',
    ai:
      'Jag kör en Iskra-server (en egen röst- och chattserver, https://github.com/quikmn/iskra-voice) på en droplet hos DigitalOcean. Hjälp mig gärna med ett problem. Be mig köra kommandon och klistra in vad de skriver ut, och förklara varje kommando först. Så här sattes den upp:\n\n' +
      '- Droplet "{{droplet}}" i regionen {{region}}, storlek {{size}}, avbild Ubuntu 24.04 LTS (x86-64), publik IPv4 {{ip}}.\n' +
      '- Uppsatt vid första starten av ett cloud-init-skript i user data (logg: /var/log/iskra-setup.log). Det installerade Iskra {{version}} från GitHub releases (iskra-server-{{version}}-linux-x64.tar.gz, kontrollerat mot SHA256SUMS.txt).\n' +
      '- Programmet i /opt/iskra; data ("world") i /opt/iskra/world: server.json (inställningar), iskra.db (SQLite), server.key, uploads/, backups/, certs/. Allt ägs av systemanvändaren "iskra".\n' +
      '- systemd-tjänsten "iskra" (/etc/systemd/system/iskra.service) kör "/opt/iskra/iskra-server /opt/iskra/world" som användaren iskra, med ExecStartPre=-/opt/iskra/iskra-update-guard och AmbientCapabilities=CAP_NET_BIND_SERVICE. Rösten är LiveKit, som servern startar själv.\n' +
      '- Adress {{url}} (ett sslip.io-namn för IP-adressen). Servern hämtar sitt eget HTTPS-certifikat från Let’s Encrypt (server.json "Https": {"Mode": "acme"}).\n' +
      '- Portar: 80/tcp (certifikatkontroll), 443/tcp (webb och WebSocket), 7881/tcp och 7882/udp (röst). Öppna i ufw på dropleten (tillsammans med 22/tcp) och i DigitalOceans molnbrandvägg "{{droplet}}-firewall": {{ssh}}.\n' +
      '- Automatiska uppdateringar från GitHub releases (server.json "Updates": {"Mode": "auto"}) och dagliga säkerhetskopior i /opt/iskra/world/backups.\n' +
      '- Loggar: journalctl -u iskra -n 200 --no-pager. Status: systemctl status iskra. Hälsa: curl -s {{url}}/health\n' +
      '- Guide: https://iskra.foo/docs/hosting\n\n' +
      'Mitt problem: <beskriv det här>',
  },
}
