import type { Messages } from '../types'

export const rental: Messages['rental'] = {
  title: 'Server bei DigitalOcean mieten',
  entry: {
    title: 'Oder lass es die App machen, bei DigitalOcean',
    text: 'Die Desktop-App kann den Server für dich in deinem eigenen DigitalOcean-Konto mieten und einrichten: ein Klick, etwa 6 $ im Monat an DigitalOcean.',
    button: 'Bei DigitalOcean mieten',
  },
  createLink: 'Möchtest du einen Server, der auch läuft, wenn dieser Computer aus ist?',
  createButton: 'Einen bei DigitalOcean mieten',
  steps: {
    label: 'Schritte',
    account: 'Konto',
    token: 'Zugriff',
    place: 'Server',
    create: 'Einrichtung',
  },
  account: {
    heading: 'Ein DigitalOcean-Konto',
    intro: 'Dein Server läuft rund um die Uhr bei DigitalOcean, einem Hosting-Anbieter. So können Freunde beitreten, auch wenn dein Computer aus ist. Du brauchst dort ein Konto; den Rest macht die App.',
    cost: 'Etwa <b>6 $ im Monat</b> für den kleinsten Server, der für Iskra reicht (1 GB Arbeitsspeicher), stundenweise abgerechnet. Du siehst den genauen Preis, bevor etwas erstellt wird. Iskra ist kostenlos und verlangt nichts.',
    credit: 'Neue DigitalOcean-Konten bekommen ein Startguthaben, die ersten Monate kosten dich also vielleicht nichts.',
    referral: 'Iskra schickt dich mit unserem Empfehlungslink zu DigitalOcean: Iskra bekommt ein kleines DigitalOcean-Guthaben, das hilft, unseren eigenen Server zu bezahlen. Du zahlst direkt an DigitalOcean; wir sehen weder deinen Server noch deine Karte.',
    open: 'DigitalOcean öffnen',
    have: 'Ich habe ein Konto',
  },
  connect: {
    heading: 'Iskra mit DigitalOcean verbinden',
    intro: 'Melde dich im Browser bei DigitalOcean an und erlaube Iskra, einen Server für dich zu erstellen. Die App bekommt einen Schlüssel, der eine Stunde gilt, behält ihn nur im Arbeitsspeicher und vergisst ihn nach der Einrichtung.',
    button: 'Mit DigitalOcean verbinden',
    waiting: 'Warten auf dich im Browser…',
    cancel: 'Abbrechen',
    fallback: 'Lieber ein API-Token nutzen',
  },
  token: {
    heading: 'Lass die App es einrichten',
    intro: 'Erstelle einen Schlüssel (ein „Personal Access Token“), mit dem diese App den Server für dich erstellen kann. Er bleibt im Arbeitsspeicher der App auf diesem Computer, geht nur an DigitalOcean und wird nach der Einrichtung verworfen.',
    step1: 'Öffne in DigitalOcean <tokens>API → Tokens</tokens> und drück auf <b>Generate New Token</b>.',
    step2: 'Nenn es „Iskra setup“ und wähle die kürzeste <b>Expiration</b> (30 Tage, oder Custom für einen Tag).',
    step3: 'Wähle unter <b>Scopes</b> die <b>Custom Scopes</b> und hake nur an: <b>droplet</b> (create, read, delete), <b>firewall</b> (create, read, delete), <b>regions</b> (read), <b>sizes</b> (read) und <b>tag</b> (create). DigitalOcean hakt vielleicht von selbst ein paar verwandte Lese-Scopes an; das ist in Ordnung.',
    step4: 'Drück auf <b>Generate Token</b>, kopiere es (es beginnt mit dop_v1_) und füge es hier ein.',
    label: 'Token',
    placeholder: 'dop_v1_…',
    next: 'Weiter',
    checking: 'Wird bei DigitalOcean geprüft…',
    back: 'Zurück',
  },
  place: {
    heading: 'Dein Server',
    region: 'Standort',
    regionHint: 'Wähle den, der eurer Gruppe am nächsten ist, damit der Sprachchat flott ist. Die App hat nach deiner Zeitzone geraten.',
    regionOption: '{{name}}: {{price}} im Monat',
    name: 'Servername',
    template: 'Startpunkt',
    size: '{{memory}} Arbeitsspeicher, {{vcpus}} CPU, {{disk}} GB Speicher, Ubuntu 24.04. <b>{{price}} im Monat</b>, von DigitalOcean stundenweise abgerechnet.',
    ssh: 'Auch SSH erlauben (Terminalzugriff)',
    sshHint: 'Standardmäßig aus: Für Iskra muss sich niemand einloggen, die Firewall lässt also nur Web und Sprachchat herein. Du kannst es später in DigitalOcean öffnen.',
    note: 'Das erstellt einen Server (ein „Droplet“) und eine Firewall in deinem DigitalOcean-Konto. Nichts wird erstellt, bevor du auf den Button drückst.',
    create: 'Server für {{price}} im Monat erstellen',
  },
  progress: {
    heading: '{{name}} wird eingerichtet',
    droplet: 'Server wird bei DigitalOcean erstellt',
    firewall: 'Firewall wird hinzugefügt (nur Web und Sprachchat)',
    booting: 'Server wird gestartet',
    installing: 'Iskra wird installiert und das HTTPS-Zertifikat geholt (meist 3–10 Minuten)',
    claiming: 'Du wirst zum Besitzer gemacht',
    keepOpen: 'Lass dieses Fenster offen; du kannst solange weiter chatten.',
    address: 'Adresse: {{url}}',
    stop: 'Stopp',
  },
  stopAsk: {
    heading: 'Einrichtung stoppen?',
    text: 'Den Server gibt es schon in deinem DigitalOcean-Konto, und er kostet Geld, solange es ihn gibt.',
    delete: 'Stoppen und löschen',
    keep: 'Behalten',
    back: 'Weitermachen',
    kept: 'Behalten. Er ist in deinem DigitalOcean-Konto (<droplets>Droplets</droplets>); lösche ihn dort, wenn du ihn nicht willst. Um später fertig zu werden, öffne „Kleinen Server mieten“ und verbinde dich mit {{ip}}.',
  },
  failed: {
    heading: 'Das hat nicht geklappt',
    created: 'In deinem DigitalOcean-Konto wurde schon ein Server erstellt. Er kostet Geld, solange es ihn gibt.',
    cleanUp: 'Bei DigitalOcean löschen',
    cleaning: 'Wird gelöscht…',
    cleaned: 'Gelöscht. Von diesem Versuch ist nichts in deinem DigitalOcean-Konto übrig.',
    cleanFailed: 'Löschen von hier aus hat nicht geklappt. Lösche ihn selbst in DigitalOcean: den Server unter <droplets>Droplets</droplets>, die Firewall unter <firewalls>Networking → Firewalls</firewalls>.',
    keepWaiting: 'Weiter warten',
    retry: 'Erneut versuchen',
    detail: 'DigitalOcean meldet: {{detail}}',
  },
  errors: {
    token: 'DigitalOcean hat dieses Token nicht angenommen. Prüfe, ob du es ganz kopiert hast und ob es noch gültig ist.',
    scope: 'Iskra fehlt eine Berechtigung bei DigitalOcean. Verbinde dich nochmal und erlaube alles, wonach gefragt wird, oder erstelle ein neues Token mit den Scopes aus den Token-Schritten.',
    limit: 'Dein DigitalOcean-Konto kann noch keinen weiteren Server haben (neue Konten starten mit einem Limit). Bitte DigitalOcean, es anzuheben, oder lösche einen Server, den du nicht nutzt.',
    rate: 'DigitalOcean bittet uns, langsamer zu machen. Warte eine Minute und versuch es nochmal.',
    network: 'DigitalOcean war nicht erreichbar. Prüfe deine Internetverbindung und versuch es nochmal.',
    server: 'DigitalOcean hatte ein Problem. Versuch es in ein paar Minuten nochmal.',
    invalid: 'DigitalOcean hat diese Anfrage abgelehnt.',
    timeoutBoot: 'Der Server ist nicht innerhalb von 5 Minuten gestartet.',
    timeoutInstall: 'Dein Server hat 25 Minuten lang nicht über HTTPS geantwortet. Vielleicht installiert er noch oder wartet auf sein Zertifikat.',
    cancelled: 'Gestoppt.',
    busy: 'Es wird schon ein Server eingerichtet.',
    denied: 'DigitalOcean hat Iskra keinen Zugriff gegeben. Versuch es nochmal oder nutze stattdessen ein API-Token.',
    unavailable: 'Aktualisiere die Desktop-App, um von hier aus einen Server zu mieten.',
  },
  done: {
    heading: 'Dein Server ist bereit',
    text: 'Du bist Besitzer von {{name}}. Tägliche Backups und automatische Updates sind an.',
    address: 'Adresse',
    cost: 'Kosten',
    costValue: '{{price}} im Monat bei DigitalOcean',
    save: 'Server-Dokument speichern',
    saved: 'Gespeichert',
    saveHint: 'Alles über deinen Server in einer Datei: Freunde einladen, Kosten und Kündigung, Updates, Backups, Umzug und ein Prompt für einen KI-Assistenten. Keine Passwörter oder Schlüssel darin.',
    tokenGone: 'Das Token ist aus dieser App verschwunden. Du kannst es auch in DigitalOcean löschen (<tokens>API → Tokens</tokens>).',
    close: 'Zu meinem Server',
  },
  doc: {
    fileName: 'Iskra-Server - {{name}}.md',
    title: '{{name}}: dein Iskra-Server',
    made: 'Erstellt von der Iskra-App am {{date}}. Bewahre diese Datei auf. Sie enthält keine Passwörter oder Schlüssel.',
    addressTitle: 'Adresse',
    address:
      '- Adresse: {{url}}\n' +
      '- IP-Adresse: {{ip}}\n' +
      '- Bei DigitalOcean: das Droplet „{{droplet}}“ in {{region}} ({{size}}), mit der Firewall „{{droplet}}-firewall“.',
    joinTitle: 'Wie Freunde beitreten',
    join: 'Öffne den Server in Iskra und drück auf **Freunde einladen**: Das erstellt einen Link, den du ihnen schickst. Sie öffnen ihn in der Iskra-App oder im Browser. Du entscheidest, wer hereinkommt: Links können ablaufen oder nur einmal gelten, und Rollen legen fest, was jemand darf.',
    keysTitle: 'Deine Schlüssel und Wiederherstellung',
    keys:
      '- Du bist der Besitzer. Dein Konto liegt auf deinen eigenen Geräten, nicht auf dem Server. Bewahre deinen **Wiederherstellungsschlüssel** (Meine Einstellungen → Wiederherstellungsschlüssel) sicher auf: Damit bekommst du dein Konto auf einem neuen Gerät zurück.\n' +
      '- Der eigene Schlüssel und die Daten des Servers liegen auf dem Server in /opt/iskra/world (server.key, iskra.db, uploads/). Tägliche Backups davon liegen in /opt/iskra/world/backups.\n' +
      '- Die Werkzeuge für Besitzer sind in der App: Servereinstellungen (Mitglieder, Rollen, Backups, Updates).',
    costTitle: 'Was es kostet und wie du kündigst',
    cost:
      '- {{price}} im Monat, von DigitalOcean stundenweise abgerechnet. Zu sehen unter Billing: {{billing}}. Iskra verlangt nichts.\n' +
      '- Um nicht mehr zu zahlen: Öffne in DigitalOcean Droplets ({{droplets}}), wähle „{{droplet}}“, dann Destroy → Destroy this Droplet. Ein Droplet, das nur ausgeschaltet ist, kostet weiter Geld; erst das Löschen beendet das. Lösche danach die Firewall „{{droplet}}-firewall“ unter Networking → Firewalls (kostenlos, aber ordentlicher).\n' +
      '- Willst du den Verlauf deines Servers behalten? Mach vorher ein Backup (Servereinstellungen → Backup & Umzug).',
    updatesTitle: 'Updates und Backups',
    updates:
      '- Iskra aktualisiert sich nachts selbst auf neue Versionen (gegen 04:00 Serverzeit, geprüft gegen die veröffentlichten Prüfsummen). Servereinstellungen → Server-Updates zeigt die Version und lässt dich das ändern.\n' +
      '- Ubuntu installiert seine eigenen Sicherheitsupdates von selbst.\n' +
      '- Jeden Tag wird auf dem Server ein Backup erstellt (die letzten 7 bleiben). Da sie auf demselben Server liegen, lade ab und zu auch eines herunter: Servereinstellungen → Backup & Umzug → Backup erstellen (verschlüsselt mit einer Passphrase, die du wählst). Die kostenpflichtigen Backups von DigitalOcean selbst sind aus.',
    moveTitle: 'Später umziehen',
    move: 'Dein ganzer Server ist ein Ordner. Erstelle ein Backup unter Servereinstellungen → Backup & Umzug, stelle es auf dem neuen Computer oder Server wieder her (Desktop-App: Server erstellen → Aus einem Backup wiederherstellen) und nutze dann **Diesen Server umziehen**, damit die Apps aller zur neuen Adresse folgen. Anleitung: {{guide}}',
    seesTitle: 'Was Iskra sehen kann und was nicht',
    sees:
      'Das Iskra-Projekt betreibt nichts für deinen Server und sieht nichts: weder deinen Server noch deine Nachrichten, dein DigitalOcean-Konto, dein Token oder deine Karte. Die App hat nur während der Einrichtung mit DigitalOcean gesprochen, mit deinem Token, und hat es vergessen. ' +
      'DigitalOcean könnte, wie jeder Hosting-Anbieter, technisch die Festplatte des Servers lesen; Direktnachrichten und verschlüsselte Kanäle sind Ende-zu-Ende-verschlüsselt, die kann es also nicht lesen. ' +
      'Dein Server selbst spricht mit GitHub (Updates) und Let’s Encrypt (sein Zertifikat), und die Nameserver von sslip.io antworten für seine Adresse.',
    aiTitle: 'Hilfe von einem KI-Assistenten',
    aiIntro: 'Wenn etwas schiefgeht, füge den Text unten in einen KI-Assistenten ein (Claude, ChatGPT…). Er beschreibt deine Einrichtung genau und enthält keine Geheimnisse.',
    sshOpen: 'SSH (22/tcp) ist erlaubt',
    sshClosed: 'SSH (22/tcp) ist nicht erlaubt; um SSH oder die Droplet Console zu nutzen, füge dieser Firewall zuerst eine eingehende Regel für TCP 22 hinzu',
    ai:
      'Ich betreibe einen Iskra-Server (ein selbst gehosteter Sprach- und Chatserver, https://github.com/quikmn/iskra-voice) auf einem DigitalOcean-Droplet. Bitte hilf mir bei einem Problem. Bitte mich, Befehle auszuführen und ihre Ausgabe einzufügen, und erklär jeden Befehl vorher. Genau so wurde er eingerichtet:\n\n' +
      '- Droplet "{{droplet}}" in der Region {{region}}, Größe {{size}}, Image Ubuntu 24.04 LTS (x86-64), öffentliche IPv4 {{ip}}.\n' +
      '- Beim ersten Start von einem cloud-init-User-Data-Skript eingerichtet (Log: /var/log/iskra-setup.log). Es hat Iskra {{version}} aus den GitHub-Releases installiert (iskra-server-{{version}}-linux-x64.tar.gz, geprüft gegen SHA256SUMS.txt).\n' +
      '- Programm in /opt/iskra; Daten ("world") in /opt/iskra/world: server.json (Einstellungen), iskra.db (SQLite), server.key, uploads/, backups/, certs/. Alles gehört dem Systembenutzer "iskra".\n' +
      '- Der systemd-Dienst "iskra" (/etc/systemd/system/iskra.service) führt "/opt/iskra/iskra-server /opt/iskra/world" als Benutzer iskra aus, mit ExecStartPre=-/opt/iskra/iskra-update-guard und AmbientCapabilities=CAP_NET_BIND_SERVICE. Der Sprachchat läuft über LiveKit, das der Server selbst startet.\n' +
      '- Adresse {{url}} (ein sslip.io-Name für die IP). Der Server holt sein eigenes HTTPS-Zertifikat von Let’s Encrypt (server.json "Https": {"Mode": "acme"}).\n' +
      '- Ports: 80/tcp (Zertifikatsprüfung), 443/tcp (Web und WebSocket), 7881/tcp und 7882/udp (Sprachchat). Offen in ufw auf dem Droplet (mit 22/tcp) und in der DigitalOcean-Cloud-Firewall "{{droplet}}-firewall": {{ssh}}.\n' +
      '- Automatische Updates aus den GitHub-Releases (server.json "Updates": {"Mode": "auto"}) und tägliche Backups nach /opt/iskra/world/backups.\n' +
      '- Logs: journalctl -u iskra -n 200 --no-pager. Status: systemctl status iskra. Health: curl -s {{url}}/health\n' +
      '- Anleitung: https://iskra.foo/docs/hosting\n\n' +
      'Mein Problem: <hier beschreiben>',
  },
}
