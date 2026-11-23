import type { Messages } from '../types'

export const rental: Messages['rental'] = {
  title: 'Wynajmij serwer na DigitalOcean',
  entry: {
    title: 'Albo niech zrobi to aplikacja, na DigitalOcean',
    text: 'Aplikacja na komputer może wynająć i skonfigurować serwer za ciebie na twoim własnym koncie DigitalOcean: jeden przycisk, około 6 $ miesięcznie płatne DigitalOcean.',
    button: 'Wynajmij na DigitalOcean',
  },
  createLink: 'Chcesz mieć serwer, który działa także przy wyłączonym komputerze?',
  createButton: 'Wynajmij go na DigitalOcean',
  steps: {
    label: 'Kroki',
    account: 'Konto',
    token: 'Dostęp',
    place: 'Serwer',
    create: 'Konfiguracja',
  },
  account: {
    heading: 'Konto DigitalOcean',
    intro: 'Twój serwer działa przez cały czas w firmie hostingowej DigitalOcean, więc znajomi mogą dołączać także przy wyłączonym komputerze. Potrzebujesz tam konta; resztę robi aplikacja.',
    cost: 'Około <b>6 $ miesięcznie</b> za najmniejszy serwer, który wystarcza dla Iskra (1 GB pamięci), rozliczany godzinowo. Dokładną cenę zobaczysz, zanim cokolwiek powstanie. Iskra jest darmowa i nic nie pobiera.',
    credit: 'Nowe konta DigitalOcean dostają środki na start, więc pierwsze miesiące mogą nic nie kosztować.',
    referral: 'Iskra kieruje cię do DigitalOcean naszym linkiem polecającym: Iskra dostaje niewielkie środki w DigitalOcean, które pomagają opłacić nasz własny serwer. Płacisz bezpośrednio DigitalOcean; nigdy nie widzimy twojego serwera ani karty.',
    open: 'Otwórz DigitalOcean',
    have: 'Mam konto',
  },
  connect: {
    heading: 'Połącz aplikację Iskra z DigitalOcean',
    intro: 'Zaloguj się do DigitalOcean w przeglądarce i pozwól aplikacji Iskra utworzyć dla ciebie jeden serwer. Aplikacja dostaje klucz ważny przez godzinę, trzyma go tylko w pamięci i zapomina po zakończeniu konfiguracji.',
    button: 'Połącz z DigitalOcean',
    waiting: 'Czekamy na ciebie w przeglądarce…',
    cancel: 'Anuluj',
    fallback: 'Użyj zamiast tego tokenu API',
  },
  token: {
    heading: 'Pozwól aplikacji to skonfigurować',
    intro: 'Utwórz klucz („personal access token”), który pozwoli tej aplikacji utworzyć dla ciebie serwer. Zostaje w pamięci aplikacji na tym komputerze, trafia tylko do DigitalOcean i jest wyrzucany po zakończeniu konfiguracji.',
    step1: 'W DigitalOcean otwórz <tokens>API → Tokens</tokens> i naciśnij <b>Generate New Token</b>.',
    step2: 'Nazwij go „Iskra setup” i wybierz najkrótszy czas w polu <b>Expiration</b> (30 dni albo Custom na jeden dzień).',
    step3: 'W sekcji <b>Scopes</b> wybierz <b>Custom Scopes</b> i zaznacz tylko: <b>droplet</b> (create, read, delete), <b>firewall</b> (create, read, delete), <b>regions</b> (read), <b>sizes</b> (read) i <b>tag</b> (create). DigitalOcean może sam zaznaczyć kilka powiązanych uprawnień odczytu; to w porządku.',
    step4: 'Naciśnij <b>Generate Token</b>, skopiuj token (zaczyna się od dop_v1_) i wklej go tutaj.',
    label: 'Token',
    placeholder: 'dop_v1_…',
    next: 'Kontynuuj',
    checking: 'Sprawdzanie w DigitalOcean…',
    back: 'Wstecz',
  },
  place: {
    heading: 'Twój serwer',
    region: 'Lokalizacja',
    regionHint: 'Wybierz najbliższą waszej grupie, żeby głos działał szybko. Aplikacja zgadła na podstawie twojej strefy czasowej.',
    regionOption: '{{name}}: {{price}} miesięcznie',
    name: 'Nazwa serwera',
    template: 'Punkt wyjścia',
    size: 'Pamięć: {{memory}}, procesory: {{vcpus}}, dysk: {{disk}} GB, Ubuntu 24.04. <b>{{price}} miesięcznie</b>, rozliczane godzinowo przez DigitalOcean.',
    ssh: 'Zezwól też na SSH (dostęp z terminala)',
    sshHint: 'Domyślnie wyłączone: do działania Iskra nikt nie musi się logować, więc zapora przepuszcza tylko WWW i głos. Możesz to otworzyć później w DigitalOcean.',
    note: 'To tworzy jeden serwer („droplet”) i zaporę na twoim koncie DigitalOcean. Nic nie powstanie, dopóki nie naciśniesz przycisku.',
    create: 'Utwórz serwer za {{price}} miesięcznie',
  },
  progress: {
    heading: 'Konfigurowanie serwera {{name}}',
    droplet: 'Tworzenie serwera w DigitalOcean',
    firewall: 'Dodawanie zapory (tylko WWW i głos)',
    booting: 'Uruchamianie',
    installing: 'Instalowanie Iskra i zdobywanie certyfikatu HTTPS (zwykle 3–10 minut)',
    claiming: 'Ustawianie cię jako właściciela',
    keepOpen: 'Zostaw to okno otwarte; w tym czasie możesz dalej czatować.',
    address: 'Adres: {{url}}',
    stop: 'Zatrzymaj',
  },
  stopAsk: {
    heading: 'Zatrzymać konfigurację?',
    text: 'Serwer już istnieje na twoim koncie DigitalOcean i kosztuje, dopóki istnieje.',
    delete: 'Zatrzymaj i usuń go',
    keep: 'Zostaw go',
    back: 'Kontynuuj',
    kept: 'Zostawiono. Jest na twoim koncie DigitalOcean (<droplets>Droplets</droplets>); usuń go tam, jeśli go nie chcesz. Żeby dokończyć później, otwórz „Wynajmij mały serwer” i połącz się z {{ip}}.',
  },
  failed: {
    heading: 'To się nie udało',
    created: 'Na twoim koncie DigitalOcean powstał już serwer. Kosztuje, dopóki istnieje.',
    cleanUp: 'Usuń go w DigitalOcean',
    cleaning: 'Usuwanie…',
    cleaned: 'Usunięto. Na twoim koncie DigitalOcean nie zostało nic z tej próby.',
    cleanFailed: 'Nie udało się usunąć go stąd. Usuń go samodzielnie w DigitalOcean: serwer w sekcji <droplets>Droplets</droplets>, zaporę w <firewalls>Networking → Firewalls</firewalls>.',
    keepWaiting: 'Czekaj dalej',
    retry: 'Spróbuj ponownie',
    detail: 'Odpowiedź DigitalOcean: {{detail}}',
  },
  errors: {
    token: 'DigitalOcean nie przyjął tego tokenu. Sprawdź, czy jest skopiowany w całości i czy nie wygasł.',
    scope: 'Aplikacji Iskra brakuje uprawnienia w DigitalOcean. Połącz ponownie i zezwól na wszystko, o co prosi, albo utwórz nowy token z uprawnieniami opisanymi w krokach.',
    limit: 'Twoje konto DigitalOcean nie może mieć na razie kolejnego serwera (nowe konta zaczynają z limitem). Poproś DigitalOcean o jego podniesienie albo usuń serwer, którego nie używasz.',
    rate: 'DigitalOcean prosi, żeby zwolnić. Poczekaj minutę i spróbuj ponownie.',
    network: 'Nie udało się połączyć z DigitalOcean. Sprawdź połączenie z internetem i spróbuj ponownie.',
    server: 'DigitalOcean ma problem. Spróbuj ponownie za kilka minut.',
    invalid: 'DigitalOcean odrzucił to żądanie.',
    timeoutBoot: 'Serwer nie wystartował w ciągu 5 minut.',
    timeoutInstall: 'Twój serwer nie odpowiedział przez HTTPS w ciągu 25 minut. Może nadal się instalować albo czekać na certyfikat.',
    cancelled: 'Zatrzymano.',
    busy: 'Trwa już konfigurowanie serwera.',
    denied: 'DigitalOcean nie dał aplikacji Iskra dostępu. Spróbuj ponownie albo użyj tokenu API.',
    unavailable: 'Zaktualizuj aplikację na komputer, żeby wynająć serwer z tego miejsca.',
  },
  done: {
    heading: 'Twój serwer jest gotowy',
    text: 'Serwer {{name}} należy do ciebie. Codzienne kopie zapasowe i automatyczne aktualizacje są włączone.',
    address: 'Adres',
    cost: 'Koszt',
    costValue: '{{price}} miesięcznie w DigitalOcean',
    save: 'Zapisz dokument swojego serwera',
    saved: 'Zapisano',
    saveHint: 'Wszystko o twoim serwerze w jednym pliku: zapraszanie znajomych, koszty i rezygnacja, aktualizacje, kopie zapasowe, przenosiny oraz prompt dla asystenta AI. Bez haseł i kluczy.',
    tokenGone: 'Tokenu nie ma już w tej aplikacji. Możesz go też usunąć w DigitalOcean (<tokens>API → Tokens</tokens>).',
    close: 'Przejdź do mojego serwera',
  },
  doc: {
    fileName: 'Serwer Iskra - {{name}}.md',
    title: '{{name}}: twój serwer Iskra',
    made: 'Utworzone przez aplikację Iskra, {{date}}. Zachowaj ten plik. Nie zawiera haseł ani kluczy.',
    addressTitle: 'Adres',
    address:
      '- Adres: {{url}}\n' +
      '- Adres IP: {{ip}}\n' +
      '- W DigitalOcean: droplet „{{droplet}}” w regionie {{region}} ({{size}}), z zaporą „{{droplet}}-firewall”.',
    joinTitle: 'Jak dołączają znajomi',
    join: 'Otwórz serwer w aplikacji Iskra i naciśnij **Zaproś znajomych**: powstanie link, który im wyślesz. Otwierają go w aplikacji Iskra albo w przeglądarce. Ty decydujesz, kto wejdzie: linki mogą wygasać albo działać tylko raz, a role określają, co kto może.',
    keysTitle: 'Twoje klucze i odzyskiwanie',
    keys:
      '- Jesteś właścicielem. Twoje konto jest na twoich urządzeniach, a nie na serwerze. Trzymaj **klucz odzyskiwania** (Moje ustawienia → Klucz odzyskiwania) w bezpiecznym miejscu: dzięki niemu odzyskasz konto na nowym urządzeniu.\n' +
      '- Klucz i dane samego serwera są na serwerze w /opt/iskra/world (server.key, iskra.db, uploads/). Jego codzienne kopie zapasowe są w /opt/iskra/world/backups.\n' +
      '- Narzędzia właściciela są w aplikacji: Ustawienia serwera (członkowie, role, kopie zapasowe, aktualizacje).',
    costTitle: 'Ile to kosztuje i jak zrezygnować',
    cost:
      '- {{price}} miesięcznie, rozliczane godzinowo przez DigitalOcean. Zobaczysz to w sekcji Billing: {{billing}}. Iskra nic nie pobiera.\n' +
      '- Żeby przestać płacić: w DigitalOcean otwórz Droplets ({{droplets}}), wybierz „{{droplet}}”, a potem Destroy → Destroy this Droplet. Droplet, który jest tylko wyłączony, nadal kosztuje; dopiero jego zniszczenie kończy opłaty. Potem usuń zaporę „{{droplet}}-firewall” w Networking → Firewalls (jest darmowa, ale dla porządku).\n' +
      '- Chcesz zachować historię serwera? Najpierw utwórz kopię zapasową (Ustawienia serwera → Kopia zapasowa i przenosiny).',
    updatesTitle: 'Aktualizacje i kopie zapasowe',
    updates:
      '- Iskra aktualizuje się sama do nowych wydań w nocy (około 04:00 czasu serwera, ze sprawdzeniem opublikowanych sum kontrolnych). Ustawienia serwera → Aktualizacje serwera pokazują wersję i pozwalają to zmienić.\n' +
      '- Ubuntu samo instaluje własne aktualizacje zabezpieczeń.\n' +
      '- Kopia zapasowa powstaje na serwerze codziennie (przechowywanych jest 7 ostatnich). Są na tym samym serwerze, więc od czasu do czasu pobierz też jedną: Ustawienia serwera → Kopia zapasowa i przenosiny → Utwórz kopię zapasową (szyfrowana wybranym przez ciebie hasłem). Płatne kopie zapasowe DigitalOcean są wyłączone.',
    moveTitle: 'Przenosiny w przyszłości',
    move: 'Cały twój serwer to jeden folder. Utwórz kopię zapasową w Ustawienia serwera → Kopia zapasowa i przenosiny, przywróć ją na nowym komputerze lub serwerze (aplikacja na komputer: Utwórz serwer → Przywróć z kopii zapasowej), a potem użyj opcji **Przenieś ten serwer**, żeby aplikacje wszystkich osób przeszły na nowy adres. Przewodnik: {{guide}}',
    seesTitle: 'Co Iskra widzi, a czego nie',
    sees:
      'Projekt Iskra niczego nie prowadzi dla twojego serwera i niczego nie widzi: ani twojego serwera, ani wiadomości, ani konta DigitalOcean, ani tokenu, ani karty. Aplikacja łączyła się z DigitalOcean tylko podczas konfiguracji, z twoim tokenem, i już go zapomniała. ' +
      'DigitalOcean, jak każda firma hostingowa, mógłby technicznie odczytać dysk serwera; wiadomości prywatne i szyfrowane kanały są szyfrowane end-to-end, więc ich odczytać nie może. ' +
      'Sam serwer łączy się z GitHubem (aktualizacje) i Let\'s Encrypt (certyfikat), a serwery nazw sslip.io odpowiadają za jego adres.',
    aiTitle: 'Pomoc asystenta AI',
    aiIntro: 'Jeśli coś pójdzie nie tak, wklej poniższy tekst do asystenta AI (Claude, ChatGPT…). Opisuje dokładnie twoją konfigurację i nie zawiera żadnych sekretów.',
    sshOpen: 'SSH (22/tcp) jest dozwolone',
    sshClosed: 'SSH (22/tcp) nie jest dozwolone; żeby użyć SSH albo Droplet Console, najpierw dodaj do tej zapory regułę przychodzącą dla TCP 22',
    ai:
      'Prowadzę serwer Iskra (własny serwer głosowy i czatu, https://github.com/quikmn/iskra-voice) na droplecie DigitalOcean. Pomóż mi z problemem. Proś mnie o uruchamianie poleceń i wklejanie ich wyników, a najpierw wyjaśniaj każde polecenie. Dokładnie tak został skonfigurowany:\n\n' +
      '- Droplet „{{droplet}}” w regionie {{region}}, rozmiar {{size}}, obraz Ubuntu 24.04 LTS (x86-64), publiczny adres IPv4 {{ip}}.\n' +
      '- Skonfigurowany przy pierwszym starcie przez skrypt user-data cloud-init (log: /var/log/iskra-setup.log). Skrypt zainstalował wersję Iskra {{version}} z wydań na GitHubie (iskra-server-{{version}}-linux-x64.tar.gz, sprawdzony z SHA256SUMS.txt).\n' +
      '- Program w /opt/iskra; dane („world”) w /opt/iskra/world: server.json (ustawienia), iskra.db (SQLite), server.key, uploads/, backups/, certs/. Właścicielem wszystkiego jest użytkownik systemowy „iskra”.\n' +
      '- Usługa systemd „iskra” (/etc/systemd/system/iskra.service) uruchamia "/opt/iskra/iskra-server /opt/iskra/world" jako użytkownik iskra, z ExecStartPre=-/opt/iskra/iskra-update-guard i AmbientCapabilities=CAP_NET_BIND_SERVICE. Głos to LiveKit, który serwer uruchamia sam.\n' +
      '- Adres {{url}} (nazwa sslip.io dla adresu IP). Serwer sam zdobywa certyfikat HTTPS od Let\'s Encrypt (server.json "Https": {"Mode": "acme"}).\n' +
      '- Porty: 80/tcp (sprawdzanie certyfikatu), 443/tcp (WWW i WebSocket), 7881/tcp i 7882/udp (głos). Otwarte w ufw na droplecie (razem z 22/tcp) oraz w zaporze chmurowej DigitalOcean „{{droplet}}-firewall”: {{ssh}}.\n' +
      '- Automatyczne aktualizacje z wydań na GitHubie (server.json "Updates": {"Mode": "auto"}) i codzienne kopie zapasowe w /opt/iskra/world/backups.\n' +
      '- Logi: journalctl -u iskra -n 200 --no-pager. Stan: systemctl status iskra. Kondycja: curl -s {{url}}/health\n' +
      '- Przewodnik: https://iskra.foo/docs/hosting\n\n' +
      'Mój problem: <opisz go tutaj>',
  },
}
