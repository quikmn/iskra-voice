// Polski. Same keys as ./en; the compiler flags anything missing or extra.
import type { DesktopText } from './en'

export const text: DesktopText = {
  tray: {
    open: 'Otwórz aplikację Iskra',
    about: 'Iskra – informacje',
    check: 'Sprawdź aktualizacje',
    checking: 'Sprawdzanie aktualizacji…',
    downloading: (version) => `Pobieranie ${version}…`,
    restart: (version) => `Uruchom ponownie i zaktualizuj do ${version}`,
    download: (version) => `Pobierz: Iskra ${version}`,
    quit: 'Zakończ aplikację Iskra',
  },
  updates: {
    titleReady: 'Aktualizacja gotowa',
    titleAvailable: 'Dostępna aktualizacja',
  },
  menu: { view: 'Widok' },
  recordings: {
    pickTitle: 'Gdzie zapisywać nagrania rozmów?',
  },
  backup: {
    pickTitle: 'Przywróć serwer z kopii zapasowej',
    filter: 'Kopie zapasowe Iskra',
    notBackup: 'Ten plik nie jest kopią zapasową Iskra.',
  },
  bots: {
    pickTitle: 'Wybierz bota, któremu ufasz',
    pickMessage: 'Uruchamiaj tylko boty, którym ufasz: bot działa z twoimi uprawnieniami na tym komputerze i może czytać oraz zmieniać twoje pliki.',
    pickButton: 'Użyj tego folderu',
    warnTitle: 'Uruchamiaj tylko boty, którym ufasz',
    runQuestion: (name: string) => `Uruchomić bota „${name}” na tym komputerze?`,
    autostartQuestion: (name: string) => `Uruchamiać bota „${name}” przy każdym starcie aplikacji Iskra?`,
    changedQuestion: (name: string) => `Bot „${name}” zmienił się od ostatniego uruchomienia. Uruchomić go mimo to?`,
    warnDetail: (folder: string) => `${folder}

Ten bot działa z twoimi uprawnieniami na tym komputerze: może czytać i zmieniać twoje pliki. Uruchamiaj tylko boty, którym ufasz.`,
    run: 'Uruchom',
    autostart: 'Uruchamiaj z aplikacją Iskra',
    cancel: 'Anuluj',
  },
  template: {
    pickTitle: 'Uruchom serwer z pliku szablonu',
    filter: 'Szablony Iskra',
    tooBig: 'Ten plik jest za duży na szablon.',
  },
  host: {
    defaultName: 'Mój serwer',
    noServer: 'Ta wersja aplikacji nie zawiera serwera.',
    stoppedEarly: 'Serwer zatrzymał się zaraz po starcie. Może jego port jest zajęty?',
    damaged: 'Pliki serwera są uszkodzone, więc nie może się on uruchomić. Plik server.log w jego folderze mówi, co jest nie tak. Pomoże przywrócenie kopii zapasowej.',
    couldntStart: (error: string) => `Nie udało się uruchomić serwera: ${error}`,
    couldntRun: (error: string) => `Serwer nie mógł działać: ${error}`,
    restoreFailed: 'Nie udało się przywrócić kopii zapasowej.',
    noPort: 'Nie znaleziono wolnego portu.',
  },
  keys: {
    mouse: (button: number) => `Mysz ${button}`,
    key: (code: number) => `Klawisz ${code}`,
  },
  passkey: {
    title: 'Klucz dostępu Iskra',
    waiting: 'Postępuj zgodnie z instrukcjami swojego urządzenia lub klucza bezpieczeństwa.',
  },
  splash: {
    title: 'Iskra',
    starting: 'Iskra się uruchamia…',
    servers: 'Uruchamianie twoich serwerów…',
    connecting: 'Łączenie…',
    ready: 'Gotowe',
    updatedTo: (version: string) => `Zaktualizowano do ${version}`,
    updating: (version: string) => `Iskra aktualizuje się do ${version}…`,
    updatingDetail: 'Wróci za kilka sekund.',
  },
  assistant: {
    title: 'Asystent Iskra',
    question: (host: string) => `Pozwolić asystentowi wysyłać twoje pytania do ${host}?`,
    detail: 'Zgódź się tylko wtedy, gdy ten adres został wpisany przez ciebie w Moje ustawienia → Asystent. Trafi tam to, o co pytasz asystenta, i to, co on dla ciebie czyta.',
    yes: 'Tak, użyj',
    no: 'Nie',
  },
  digitalOcean: {
    done: 'Połączono z DigitalOcean. Możesz zamknąć tę kartę i wrócić do aplikacji Iskra.',
    denied: 'Nie połączono aplikacji Iskra z DigitalOcean. Możesz zamknąć tę kartę i wrócić do aplikacji Iskra.',
  },
}
