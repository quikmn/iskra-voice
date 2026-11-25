# Glosariusz: polski (`pl`)

The Polish terms for Iskra's interface. Same sections and English terms as [`docs/i18n-glossary.md`](../i18n-glossary.md);
rules for translators in [`docs/translating.md`](../translating.md).

## Decisions for the whole language

**Form of address: second person singular, informal ("ty").** Discord, Messenger, WhatsApp, Telegram, Steam and Twitch all
address a Polish user this way ("Zaproś znajomych", "Twoje konto", "Nie masz jeszcze znajomych"). The formal
"Pan/Pani" reads like a bank or an office, and the plural "wy" like an advert. Iskra is a chat app for friend groups,
so it says "ty".

- Buttons, menu items and commands are imperatives in the second person singular: "Zapisz", "Wyślij", "Dołącz",
  "Zaproś znajomych". Never infinitives ("Zapisać") and never first person ("Zapisuję").
- "ty", "twój", "ci", "cię", "tobie" are written in lower case inside a sentence (as Discord and Steam do; the capital
  letter belongs in letters). At the start of a sentence they get a capital like any word.
- The pronoun is usually left out: "Masz niezapisane zmiany", not "Ty masz…".
- The app speaks about itself as "Iskra" in the third person ("Iskra próbuje dalej w tle"), not "my".

**No assumed gender.** Polish past tense, participles and many adjectives show gender.

- About the reader: use the present tense, the impersonal "-no/-to" form, or a noun. "Wyrzucono cię z serwera" (not
  "Zostałeś wyrzucony"), "Na pewno?" (not "Jesteś pewien?"), "Mikrofon wyciszony" (not "Jesteś wyciszony"),
  "Nie masz uprawnień" (not "Nie jesteś uprawniony"), "Masz już konto" (not "Jesteś zalogowany" → "Zalogowano").
- About `{{name}}`: the same. Prefer a noun or passive wording where the name follows a colon or "przez":
  "Przypięte przez: {{name}}", "Zaproszenie od: {{name}}". In running event lines use the present tense:
  "{{name}} dołącza do serwera", "{{name}} przypina wiadomość", "{{name}} dzwoni", "{{name}} pisze…".
  The audit log is written this way too ("{{actor}} wyrzuca użytkownika {{target}}").
  Never "dołączył(a)", never "dołączył/a".
- Role and person nouns keep their dictionary (masculine) form as labels: "Właściciel", "Moderator", "Członek",
  "Gość", "znajomy". Where a neutral word reads as well, prefer it: "osoba", "ktoś", "nikt".

**Names and numbers are inserted as they are.** A name can't be declined, so:

- Keep `{{name}}` in the nominative where possible: as the subject, or after a colon ("Wiadomość do: {{name}}" only
  where a label fits).
- Otherwise put a noun in front that carries the case: "na serwerze {{name}}", "na kanale #{{channel}}",
  "do użytkownika {{name}}", "z folderu {{name}}", "rola {{role}}". After such a noun the bare name is correct Polish.
- Short prepositional uses where a helper noun would be clumsy may keep the bare name ("Napisz do {{name}}"), as
  Discord and Messenger do.
- A number other than `{{count}}` in a plural key has no forms: use an abbreviation or a wording that doesn't
  decline ("{{n}} min", "{{seconds}} s", "Maks. {{max}}", "Limit: {{max}}", "Liczba wiadomości: {{n}}").

**Plural forms.** Every counting text has four: `_one` (1), `_few` (2–4, 22–24…), `_many` (0, 5–21, 25–31…),
`_other` (fractions).

| Form | Rule | Example |
|---|---|---|
| `_one` | nominative singular | 1 wiadomość, 1 członek, 1 nowa wzmianka |
| `_few` | nominative plural | 2 wiadomości, 3 członków (personal masculine takes the genitive: "3 członków", "2 znajomych"), 2 nowe wzmianki |
| `_many` | genitive plural | 5 wiadomości, 5 członków, 5 nowych wzmianek |
| `_other` | genitive singular | 1,5 wiadomości, 1,5 członka, 1,5 nowej wzmianki |

The verb and adjective follow the form: "1 osoba pisze", "2 osoby piszą", "5 osób pisze"; "Został 1 dzień",
"Zostały 2 dni", "Zostało 5 dni", "Zostało 1,5 dnia". Persons are counted as "osoba" where that avoids gender
("2 osoby", not "2 członków", when either fits).

**Case.** Sentence case everywhere: only the first word and proper names get a capital ("Zaproś znajomych",
"Moje ustawienia", "Ustawienia serwera"). No English Title Case. Names of the app's own sections and features keep
their capital when a sentence points at them: "Moje ustawienia → Urządzenia", "we Wspólnym oglądaniu" (feature names
are declined like ordinary words).

**Typography.**

- Quotation marks: „…” (U+201E, U+201D). Never "…" or '…' around words. Straight quotes stay only where the text shows literal code: JSON keys ("meta", "radius"), shell commands and file contents in the prompts for AI assistants.
- Dash: " – " (en dash with spaces) between parts of a sentence. Hyphen only inside words ("GIF-y", "e-mail").
- Ellipsis: "…" (one character), no space before it.
- No space before `:` `?` `!` `;`.
- Numbers: decimal comma ("1,5 GB"), a space between number and unit ("5 MB", "10 min", "30 s", "50%" without a
  space). The app formats dates and large numbers itself.
- Abbreviations: "np." (e.g.), "itd.", "maks.", "min" (minutes, no dot), "godz.", "s", "ok." (about).
- Arrows in paths stay: "Moje ustawienia → Powiadomienia".
- Key names stay English: `Ctrl`, `Shift`, `Enter`, `Esc`, `Tab`; "Spacja" for Space only in running text.

**Loanwords kept** because Polish users say them: serwer, czat, bot, link, emoji, GIF, webhook, ban, spoiler, online,
offline, soundboard, streamer, lobby, host/hosting, backup only as "kopia zapasowa", e-mail, PIN, QR.
Declined the Polish way: "na Discordzie", "z Discorda", "boty", "webhooki", "GIF-y", "linki". "Iskra" itself is
never declined in a way that changes the word: write the sentence so it stays "Iskra" ("aplikacja Iskra",
"w aplikacji Iskra", "Otwórz aplikację Iskra", "Iskra łączy się ponownie"). The checks require the exact word "Iskra".

**Tone.** Plain, short, friendly. Say what can be done next. "Nie udało się…" for failures ("Nie udało się wysłać."),
"Spróbuj ponownie" for retry. No "Ups!", no "niestety" in every error, no office language ("uprzejmie informujemy",
"niniejszy", "w celu").

## People and places

| English | Polski | Notes |
|---|---|---|
| Name | Nazwa | The Iskra name of a person: "Twoja nazwa". Never "imię" (people pick nicks) and never "nazwa użytkownika" (there are no usernames) |
| Server nickname | Pseudonim na serwerze ("Pseudonim na serwerze {{server}}") | Reset: "Use my name" → "Użyj mojej nazwy" |
| Owner, Admin, Moderator, Trusted, Member, Guest | Właściciel, Admin, Moderator, Zaufany, Członek, Gość | Plurals: właściciele, admini, moderatorzy, zaufani, członkowie, goście. Lower case in running text. "Admin", not "Administrator" |
| Role | Rola | Never "poziom", never "ranga" |
| Built-in role (badge "Built-in") | Rola wbudowana (badge "Wbudowana") | Custom roles: "własne role" |
| Permission | Uprawnienie | Plural "uprawnienia". Never "prawa", "pozwolenia" |
| Bot, bots | Bot, boty | |
| Server | Serwer | |
| Channel, text channel, voice channel | Kanał, kanał tekstowy, kanał głosowy | Never "pokój" for a voice channel. "na kanale", not "w kanale" |
| Stage | Scena | Stage channel: "kanał sceniczny" only where the kind must be named; otherwise "scena" |
| Thread | Wątek | |
| Forum post | Post | Forum: "forum"; comments under it: "odpowiedzi" |
| Direct message(s) | Wiadomość prywatna, wiadomości prywatne | Short tab label where space is tight: "Prywatne". Never "DM", "PW" or "priv" |
| Group chat | Czat grupowy | Short: "grupa" where the context is clear |
| Device | Urządzenie | |
| Account | Konto | |

## Settings

| English | Polski |
|---|---|
| My settings | Moje ustawienia |
| Language (section) | Język |
| Server settings | Ustawienia serwera |
| Server, Members & safety, Apps, Hosting & data (groups) | Serwer, Członkowie i bezpieczeństwo, Aplikacje, Hosting i dane |
| Overview | Przegląd |
| Server icon, banner | Ikona serwera, baner |
| Channels | Kanały |
| Emoji & stickers | Emoji i naklejki |
| GIFs | GIF-y |
| Soundboard | Soundboard |
| Profile pages | Strony profilowe |
| Server rules | Zasady serwera |
| Members | Członkowie |
| Roles | Role |
| Reports | Zgłoszenia |
| AutoMod (nav and heading) | AutoMod |
| Audit log (who changed what; never "activity log", which is games) | Dziennik zmian |
| Sign-ins & security (never "security log" as a name) | Logowania i bezpieczeństwo |
| Bots & webhooks | Boty i webhooki |
| Internet access (section) / Open to the internet (its switch) | Dostęp z internetu / Pozwól znajomym dołączać z dowolnego miejsca (the switch's English text is "Let friends anywhere join"; the state is "otwarty na internet") |
| Limits | Limity |
| Backup & move | Kopia zapasowa i przenosiny |
| Import from Discord | Import z Discorda |
| Server updates | Aktualizacje serwera |
| Notifications | Powiadomienia |
| Recovery key | Klucz odzyskiwania |
| App lock | Blokada aplikacji |

## Actions

| English | Polski | Notes |
|---|---|---|
| Invite friends | Zaproś znajomych | |
| Invite link | Link z zaproszeniem | Invite (noun): "zaproszenie" |
| Hide server (only off your list) | Ukryj serwer | |
| Leave server (really leaves) | Opuść serwer | |
| Sign out | Wyloguj się | Sign in: "Zaloguj się"; a sign-in (noun): "logowanie" |
| Kick | Wyrzuć | Noun: "wyrzucenie" |
| Ban, unban | Zbanuj, odbanuj | Noun: "ban" ("bany", "lista banów") |
| Time out / timeout | Wyślij na przerwę / przerwa | "Na przerwie do {{time}}"; end early: "Zakończ przerwę" |
| Slowmode | Tryb powolny | |
| Mute (yourself) / Deafen | Wycisz mikrofon / Wyłącz dźwięk | Undo: "Włącz mikrofon" / "Włącz dźwięk". States: "Mikrofon wyciszony" / "Dźwięk wyłączony" |
| Mute (someone else, for you) / Server mute | Wycisz / Wycisz na serwerze | "Wycisz u mnie" for "Mute for me". Server deafen: "Wyłącz dźwięk na serwerze" |
| Push to talk | Naciśnij i mów | |
| Pin, unpin | Przypnij, odepnij | "Przypięte wiadomości" |
| Report (noun) | Zgłoszenie | Verb: "Zgłoś" |
| Upload | Prześlij | Noun: "przesyłanie". Download: "Pobierz" |
| Preview | Podgląd | |
| Delete / Remove | Usuń / Usuń | Polish has one everyday word. Where the two must differ on one screen: "Usuń na stałe" (delete) against "Usuń" or "Zabierz" (take off a list). Never "Skasuj" |
| Optional | Opcjonalnie | As a field tag: "opcjonalne" |
| e.g. (example placeholders: "e.g. game-night") | np. ("np. wieczór-gier") | |

## Features

| English | Polski | Notes |
|---|---|---|
| Mention | Wzmianka (verb: wspomnieć o kimś, "Wspomnij o kimś") | "@wzmianki" |
| Poll | Ankieta | Vote: "głos", "Zagłosuj" |
| Teams (team splitter; one team, "Team 1") | Drużyny (podział na drużyny; "Drużyna 1") | |
| Looking for group (LFG post) | Szukam ekipy (the post: "ogłoszenie"; "LFG" only where short) | |
| Event | Wydarzenie | |
| Sticker | Naklejka | |
| Emoji | Emoji (not declined, no plural ending) | |
| Watch party | Wspólne oglądanie (as a name: "we Wspólnym oglądaniu") | |
| Clip | Klip | |
| Catch up | Nadrób zaległości (button); "Co cię ominęło" (heading) | |
| Passkey | Klucz dostępu | The term Google, Apple and Microsoft use in Polish |
| Passphrase | Hasło | "długie hasło" where the difference from a short password matters. Polish has no everyday word for "passphrase" |
| End-to-end encrypted | Szyfrowanie end-to-end / szyfrowane end-to-end | As WhatsApp and Signal say in Polish. Short badge: "Szyfrowane end-to-end" |
| Decrypt | Odszyfrować | "Nie udało się odszyfrować" |
| Backup | Kopia zapasowa | Never "backup" |

## Server messages

The server's errors (`errors.server`, `errors.codes`) and the push texts (`client/public/push-text/pl.js`) use the
same words as the rest of this file. Errors say what happened in one short sentence and, where it helps, what to do:
"Nie udało się…", "Nie masz uprawnień, żeby…", "Ten kanał już nie istnieje.", "Spróbuj ponownie za chwilę."

## More terms

Terms that aren't in the English glossary but come up often.

### Chat

| English | Polski | Notes |
|---|---|---|
| Message | Wiadomość | |
| Reply | Odpowiedź, "Odpowiedz" | |
| Forward | Przekaż dalej | "Przekazana wiadomość" |
| Reaction | Reakcja | "Dodaj reakcję" |
| Attachment | Załącznik | "Załącz pliki" |
| File, picture, video | Plik, obraz, film | "obraz", not "zdjęcie", unless it is a photo; "wideo" for video as a medium ("rozmowa wideo") |
| Edit, edited | Edytuj, "edytowano" | |
| Copy, paste | Kopiuj, wklej | "Skopiowano" |
| Typing | "{{name}} pisze…" | |
| Unread | Nieprzeczytane | "Oznacz jako przeczytane" |
| Draft | Wersja robocza | |
| Scheduled message | Zaplanowana wiadomość | "Zaplanuj" |
| Reminder | Przypomnienie | "Przypomnij mi" |
| Saved messages, bookmark | Zapisane wiadomości, "Zapisz" | |
| Spoiler | Spoiler | |
| Topic (channel) | Temat kanału | |
| Category | Kategoria | |
| Folder (of servers) | Folder | |
| Search | Szukaj; wyszukiwanie | "Brak wyników" |
| Inbox | Skrzynka | |
| Follow (a person, a thread) | Obserwuj, "obserwowane" | |
| Alert word | Słowo alarmowe | "słowa alarmowe" |
| Quiet hours | Godziny ciszy | |
| Digest | Podsumowanie | |
| Voice message | Wiadomość głosowa | |
| Disappearing messages | Znikające wiadomości | |
| Translate | Przetłumacz; tłumaczenie | |
| Link | Link | Never "odnośnik", "łącze" |
| Markdown, code block | Markdown, blok kodu | |
| Tag (forum, media) | Tag | |
| Docs channel, page | Kanał dokumentów, strona | Kind label: "Dokumenty" |
| Media channel, gallery | Kanał multimediów, galeria | Kind label: "Multimedia" |
| Forum channel | Kanał forum | Kind label: "Forum" |
| Whiteboard | Tablica | |
| Activity (games in a call) | Aktywność, aktywności | Activity log: "dziennik aktywności" |
| Game, round, score, lobby | Gra, runda, wynik, lobby | |
| Quiz / trivia | Quiz | |
| Draw & guess | Rysuj i zgaduj | |
| Four in a row | Cztery w rzędzie | |
| Built-in bots: Dice, Polls, Reminders, Starboard, Birthdays, Welcome, Feeds, Tags, Suggestions, Giveaways, Counting | Kości, Ankiety, Przypomnienia, Tablica gwiazdek, Urodziny, Powitania, Źródła, Tagi, Sugestie, Losowania, Liczenie | Command names and their keywords stay English: /giveaway end, /tag list, /remind me in 10m |
| Giveaway, reroll | Losowanie, losuj ponownie | |
| Suggestion; Suggest (button) | Sugestia; Zaproponuj | |
| Docs: Start here page, sub-page | Strona „Zacznij tutaj”, podstrona | |
| Sticky note (whiteboard) | Karteczka | |

### Voice and calls

| English | Polski | Notes |
|---|---|---|
| Voice (the state of being in a voice channel) | "na kanale głosowym"; short label "Głos" | "In voice" → "Na kanale głosowym"; "Leave voice" → "Rozłącz się" |
| Call | Rozmowa | "Zadzwoń", "{{name}} dzwoni", group call: "rozmowa grupowa" |
| Hang up / Leave call | Rozłącz się / Opuść rozmowę | |
| Answer / Decline | Odbierz / Odrzuć | |
| Camera, microphone, speaker, headphones | Kamera, mikrofon, głośnik, słuchawki | Output device: "głośnik" |
| Screen sharing | Udostępnianie ekranu | "Udostępnij ekran", "Zakończ udostępnianie" |
| Volume | Głośność | |
| Noise suppression | Redukcja szumów | |
| Captions | Napisy | Transcript: "transkrypcja" |
| Recording | Nagranie; nagrywanie | "Nagraj", "Zatrzymaj nagrywanie" |
| Speaker (on a stage), audience, listener | Mówca, publiczność, słuchacz | "Raise hand" → "Podnieś rękę"; "Ask to speak" → "Poproś o głos"; "Go live" → "Zacznij na żywo" |
| Host (watch party) | Gospodarz | Quizmaster: "prowadzący" |
| Hi-fi audio, echo cancellation, voice activity | Dźwięk hi-fi, usuwanie echa, aktywacja głosem | |
| Priority speaker | Mówca priorytetowy | |
| Whisper | Szept; "Szepcz" | Whisper key: "klawisz szeptu" |
| AFK channel | Kanał AFK | |
| Voice room (join-to-create), lobby, host | Pokój głosowy, lobby, gospodarz | Only here "pokój": a temporary room made from a lobby |
| Pop out, picture-in-picture | Otwórz w osobnym oknie, obraz w obrazie | |
| Streamer mode | Tryb streamera | |
| Text to speech / speech to text | Czytanie na głos / dyktowanie | "TTS" stays where English shows the abbreviation |

### People and presence

| English | Polski | Notes |
|---|---|---|
| Friend, friends | Znajomy, znajomi | "Dodaj do znajomych", "Usuń ze znajomych". Never "przyjaciel" |
| Friend request / message request | Zaproszenie do znajomych / prośba o wiadomość | |
| Block, unblock | Zablokuj, odblokuj | |
| Ignore | Ignoruj | |
| Profile | Profil | |
| Status: Online, Idle, Do not disturb, Invisible, Offline | Online, Zaraz wracam, Nie przeszkadzać, Niewidoczny, Offline | Custom status: "własny status" |
| Away | "poza komputerem"; status label as Idle | |
| Someone / nobody / everyone | Ktoś / nikt / wszyscy | |
| You (label) | Ty | In lists in lower case: "ty" |

### Account and security

| English | Polski | Notes |
|---|---|---|
| Sign in / sign-in | Zaloguj się / logowanie | |
| Link a device | Połącz urządzenie | "Połączone urządzenia" |
| Safety number | Numer bezpieczeństwa | As Signal says in Polish |
| Verify | Zweryfikuj | "Zweryfikowano" |
| Key (cryptographic) | Klucz | Keybind is "skrót klawiszowy" |
| Keybind, shortcut | Skrót klawiszowy, skrót | Section "Keybinds" → "Skróty klawiszowe" |
| Password, PIN, code | Hasło, PIN, kod | |
| Security key | Klucz bezpieczeństwa | |
| Encrypted / not encrypted | Szyfrowane / nieszyfrowane | |
| Privacy & safety | Prywatność i bezpieczeństwo | |
| Appearance, theme | Wygląd, motyw | |
| Assistant | Asystent | |
| Key transparency, key log | Przejrzystość kluczy, dziennik kluczy | |
| Keychain / keyring | Pęk kluczy | |
| "I already use Iskra" (first-run choice) | „Mam już konto Iskra” | Quoted with this wording wherever another text points at it |
| Profile picture / picture on this server | Zdjęcie profilowe / obraz na tym serwerze | |

### Moderation

| English | Polski | Notes |
|---|---|---|
| Moderation | Moderacja | |
| Warn, warning | Ostrzeż, ostrzeżenie | |
| Note (mod note) | Notatka | |
| History | Historia | |
| Reason | Powód | |
| Join question | Pytanie na wejście | "pytania na wejście" |
| Waiting to join / let in | "Czeka na wpuszczenie" / Wpuść | |
| Raid | Rajd | |
| Pause / resume invites | Wstrzymaj / wznów zaproszenia | |
| Revoke (an invite) | Unieważnij | |
| Lock / close (a forum post) | Zablokuj odpowiedzi / zamknij post | "Zablokuj" alone means blocking a person |
| Transfer ownership | Przekaż własność | The menu item is quoted with this exact wording elsewhere |
| Ranked below you | "stoi niżej od ciebie", "niższa rola" | Never "ranga" |
| Public page | Strona publiczna | |

### Hosting

| English | Polski | Notes |
|---|---|---|
| Host (verb), hosting, self-hosted | Hostować, hosting, "na własnym serwerze" | |
| Create a server / Start your own server | Utwórz serwer / Uruchom własny serwer | "Utwórz" for creating things (channel, role, poll, thread); never "Stwórz" |
| Join a server | Dołącz do serwera | |
| Rent a server | Wynajmij serwer | |
| Claim a server, claim code | Przejmij serwer, kod przejęcia | |
| Droplet (DigitalOcean) | droplet | DigitalOcean's own word |
| Template | Szablon | |
| Backup buddies | Zaufane kopie | A friend's server that keeps your encrypted backups. One buddy: "zaufana kopia"; the other side: "serwer znajomych"; a spot: "miejsce"; pairing code: "kod parowania" |
| Restore | Przywróć | |
| Move (a server) | Przenieś | |
| Update, restart | Aktualizacja / zaktualizuj, uruchom ponownie | |
| Address, port, tunnel | Adres, port, tunel | |
| Storage, limit | Miejsce na dane, limit | |
| Feed (RSS) | Kanał RSS; "źródło" in lists | The Feeds bot: "bot Źródła" → use "Źródła" |
| Webhook | Webhook | "webhooki" |
| Slash command | Polecenie | "/roll" stays |
| Export | Eksport, "Eksportuj" | |
| Import | Import, "Importuj" | |
| World (a server's data folder) | Folder serwera | |
| Desktop app | Aplikacja na komputer | Never "aplikacja desktopowa" |
| Tray | Zasobnik (systemowy) | |
| Outgoing webhook | Webhook wychodzący | |
| Signing secret | Sekret podpisywania | |
| Build attestation | Poświadczenie kompilacji | |
| Snapshot | Migawka | |
| Setup text (User data) | Tekst konfiguracyjny | Provider UI labels stay English: "User data", "Droplets", "Generate New Token" |

### Common buttons

| English | Polski |
|---|---|
| Cancel / Save / Close / Done / OK | Anuluj / Zapisz / Zamknij / Gotowe / OK |
| Edit / Add / Create / Send | Edytuj / Dodaj / Utwórz / Wyślij |
| Back / Next / Continue | Wstecz / Dalej / Kontynuuj |
| Retry, Try again | Spróbuj ponownie |
| Apply / Reset / Clear | Zastosuj / Resetuj / Wyczyść |
| Join / Leave | Dołącz / Opuść |
| Open / Undo / More | Otwórz / Cofnij / Więcej |
| Dismiss | Odrzuć (a notice: "Zamknij") |
| Discard | Odrzuć |
| Keep | Zostaw |
| Not now / Later | Nie teraz / Później |
| Turn on / Turn off | Włącz / Wyłącz |
| On / Off | Wł. / Wył. |
| Show more / Show less | Pokaż więcej / Pokaż mniej |
| Loading… / Saving… / Connecting… | Wczytywanie… / Zapisywanie… / Łączenie… |
| Reconnecting… | Ponowne łączenie… |
| Couldn't … | Nie udało się … |
| Something went wrong | Coś poszło nie tak |
| Learn more | Dowiedz się więcej |

## Task boards

| English | Polski | Notes |
|---|---|---|
| Task board (the channel kind "Tasks") | Tablica zadań | Kind label: "Zadania". Short "tablica" only inside the board itself, where it can't be taken for a whiteboard ("Tablica"); in a header: "Zadanie na kanale {{name}}" |
| Task | Zadanie | "zadania", "zadań" |
| To do / Doing / Done (the columns) | Do zrobienia / W toku / Gotowe | |
| Assign, assigned to, "Assign me" | Przypisz, "Przypisane do" (label) / "Przypisane: {{names}}", "Przypisz mnie" | Undo: "Wypisz mnie". Event line: "{{name}} przypisuje ci zadanie" |
| Label (on a task; a forum has tags) | Etykieta | Never "tag" on a task |
| Due (a task's due day) | Termin | "Termin: {{date}}", "Termin: dziś", passed: "Po terminie: {{date}}", none: "Bez terminu" |
| Archive, archived (a done task put away) | Archiwizuj, zarchiwizowane | The place: "archiwum"; back: "Przywróć na tablicę" |
| Comment (on a task) | Komentarz | Forum posts have "odpowiedzi" |

## Photos channels

| English | Polski | Notes |
|---|---|---|
| Photos channel (the channel kind "Photos") | Kanał zdjęć | Kind label: "Zdjęcia". One: "zdjęcie"; "zdjęcia", "zdjęć". A video in it: "film" |
| Album / "No album" | Album / "Bez albumu" | "albumy", "albumów" |
| Add photos | Dodaj zdjęcia | |
| Date taken | Data wykonania | "Wykonano {{taken}}"; when it was added: "Dodano {{date}}" |
| Caption | Podpis | As in a media channel. Never "napisy" (voice captions) |
| Storage / storage limit | Miejsce na dane / limit miejsca | In the audit log and errors: "miejsce na zdjęcia", "limit miejsca na zdjęcia" |
| Cover (album cover) | Okładka (okładka albumu) | |
| Hidden data / metadata | Ukryte dane / metadane | "Ukryte dane" in the app's own texts; "metadane" only in the server's error |
| Select | Zaznacz | "Zaznacz wszystkie", "Zaznaczono: {{count}}" |
| Download album | Pobierz album | All of a channel: "Pobierz wszystko" |
