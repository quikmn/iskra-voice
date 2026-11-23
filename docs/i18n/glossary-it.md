# Glossario italiano

One word per thing in the Italian texts: the catalog (`client/src/i18n/it/`), the desktop app
(`desktop/src/text/it.ts`), the push texts (`client/public/push-text/it.js`) and the activities. Same sections and
English terms as [`docs/i18n-glossary.md`](../i18n-glossary.md); format and rules in
[translating.md](../translating.md#glossary).

## Rules for the whole language

- **Address:** informal "tu" everywhere, never "Lei" or "voi" for one person. Buttons and menu items use the
  imperative ("Salva", "Invita amici", "Riprova"), never the infinitive.
- **Gender:** don't assume the reader's or another person's gender. A name is inserted as it is, so avoid past
  participles that agree with it: use verbs with "avere" ("{{name}} ha lasciato il server", "{{name}} ha avviato una
  chiamata") or a noun ("{{name}} è online", "{{name}} è in vocale") instead of "è entrato/a", "si è unito/a".
  "Ti diamo il benvenuto" instead of "Benvenuto"; "Vuoi davvero…?" instead of "Sei sicuro?"; "Hai il microfono
  disattivato" instead of "Sei mutato"; "Ti hanno espulso" instead of "Sei stato espulso". Never "o/a", "ə" or "*".
  Role names (Proprietario, Moderatore, Membro, Ospite, Fidato) and generic nouns (amico, utente) keep their dictionary
  form.
- **Case:** sentence case in headings, buttons and menu items ("Impostazioni del server", "Invita amici"). Only the
  first word and proper names get a capital. Feature names used as names keep one capital ("Guarda insieme",
  "Rimettiti in pari"). Role names take a capital as labels and when naming the role ("il ruolo Moderatore"), lower
  case in running text ("chiedi a un admin", "un moderatore").
- **Typography:** `…` is one character (U+2026). Quotation marks are «…» with no inner spaces («{{name}}»). The
  apostrophe is the plain `'`. Capital accented letters are written as such ("È", never "E'"). Accents: perché,
  poiché, né, sé (grave on è, cioè, caffè). No space before `?`, `!`, `:`. A dash in running text is ` – `; where
  English uses `·` as a separator it stays. Few exclamation marks, where English has them.
- **Numbers and units:** the app formats numbers and dates. Written by hand: "5 min", "2 MB", "10 s", decimal
  comma, 24-hour clock.
- **Loanwords** are invariable in the plural and take these genders: il server, il bot, la chat, il link, il file,
  il thread, il post, il ban, il timeout, il backup, l'account (m.), la password, la passkey, la clip, l'emoji (f.:
  "un'emoji", "le emoji"), lo sticker (gli sticker), la GIF, il webhook, il feed, il forum, la soundboard.
- **Plain words:** a normal Italian word where one exists ("impostazioni", "canale", "messaggio", "carica",
  "scarica", "accedi"). No "cliccare" where a phone is also meant: "tocca" on phones only, otherwise "fai clic" or
  better name the action ("Scegli…", "Apri…").
- **Errors:** say what happened and what to do next, without blame: "Non è stato possibile…" or "Impossibile…" for
  short ones, then "Riprova." "Couldn't X" → "Impossibile X" in toasts and titles.

## People and places

| English | Italiano | Notes |
|---|---|---|
| Name | Nome | Your Iskra name, everywhere unless a server nickname is set |
| Server nickname | Soprannome sul server ("Soprannome su {{server}}" when the server is named) | Reset: "Usa il mio nome". Never "nickname" |
| Owner, Admin, Moderator, Trusted, Member, Guest | Proprietario, Admin, Moderatore, Fidato, Membro, Ospite | Plural: proprietari, admin (invariable), moderatori, fidati, membri, ospiti |
| Role | Ruolo | Never "livello" |
| Built-in role (badge "Built-in") | Ruolo integrato (badge "Integrato") | Custom roles: "ruoli personalizzati". "Predefinito" is kept for "default" |
| Permission | Permesso | Never "autorizzazione" or "diritto" for what a role allows |
| Bot, bots | Bot, bot | Invariable, masculine |
| Server | Server | Invariable, masculine |
| Channel, text channel, voice channel | Canale, canale testuale, canale vocale | Never "stanza" for a voice channel. "In voice" = "In vocale" |
| Stage | Palco | |
| Thread | Thread | Invariable, masculine. Never "discussione" (that could be a forum post) |
| Forum post | Post | Invariable, masculine |
| Direct message(s) | Messaggio diretto, messaggi diretti | "DM" only as a short tab label where space is tight, never in sentences |
| Group chat | Chat di gruppo | Never "DM di gruppo". A plain group in chat: "gruppo" |
| Device | Dispositivo | |
| Account | Account | Masculine: "il tuo account" |

## Settings

| English | Italiano | Notes |
|---|---|---|
| My settings | Le mie impostazioni | |
| Language (section) | Lingua | |
| Server settings | Impostazioni del server | |
| Server, Members & safety, Apps, Hosting & data (groups) | Server, Membri e sicurezza, App, Hosting e dati | "&" is always "e" |
| Overview | Panoramica | |
| Server icon, banner | Icona del server, banner | |
| Channels | Canali | |
| Emoji & stickers | Emoji e sticker | |
| GIFs | GIF | |
| Soundboard | Soundboard | Feminine: "la soundboard"; one sound is "un suono" |
| Profile pages | Pagine profilo | |
| Server rules | Regole del server | |
| Members | Membri | |
| Roles | Ruoli | |
| Reports | Segnalazioni | |
| AutoMod (nav and heading) | AutoMod | |
| Audit log (who changed what; never "activity log", which is games) | Registro di controllo | Never "registro attività" (attività = games and activities) |
| Sign-ins & security (never "security log" as a name) | Accessi e sicurezza | |
| Bots & webhooks | Bot e webhook | |
| Internet access (section) / Open to the internet (its switch) | Accesso da internet / Apri a internet | "open to the internet" in a sentence: "aperto a internet" |
| Limits | Limiti | |
| Backup & move | Backup e trasferimento | Move a server: "trasferire" |
| Import from Discord | Importa da Discord | |
| Server updates | Aggiornamenti del server | |
| Notifications | Notifiche | |
| Recovery key | Chiave di recupero | |
| App lock | Blocco app | |

## Actions

| English | Italiano | Notes |
|---|---|---|
| Invite friends | Invita amici | |
| Invite link | Link d'invito | An invite: "invito" |
| Hide server (only off your list) | Nascondi il server | |
| Leave server (really leaves) | Abbandona il server | "Leave" a group, call or voice channel is also "Abbandona"; bare button "Leave": "Abbandona" |
| Sign out | Esci | Sign in: "Accedi"; a sign-in: "accesso"; signed in: "hai effettuato l'accesso" |
| Kick | Espelli | Noun: "espulsione" |
| Ban, unban | Banna, revoca il ban | Noun: "ban"; banned people: "utenti bannati" / "Ban" as a list title |
| Time out / timeout | Metti in timeout / timeout | Remove: "Togli il timeout" |
| Slowmode | Modalità lenta | |
| Mute (yourself) / Deafen | Disattiva il microfono / Disattiva l'audio | Unmute / undeafen: "Attiva il microfono" / "Attiva l'audio". States: "Microfono disattivato", "Audio disattivato" |
| Mute (someone else, for you) / Server mute | Silenzia / Silenzia sul server | Also for muting a channel's, server's or chat's notifications: "Silenzia". Undo: "Riattiva l'audio" for a person, "Riattiva le notifiche" for a channel |
| Push to talk | Premi per parlare | |
| Pin, unpin | Fissa, non fissare più | Pinned messages: "messaggi fissati". Never "pinnare" |
| Report (noun) | Segnalazione | Verb: "Segnala" |
| Upload | Carica | Noun: "caricamento". Download: "Scarica", "download" |
| Preview | Anteprima | As a verb: "Mostra anteprima" |
| Delete / Remove | Elimina / Rimuovi | Delete destroys; remove takes out of a list. Never "cancella" for either ("Annulla" is Cancel) |
| Optional | Facoltativo | |
| e.g. (example placeholders: "e.g. game-night") | es. ("es. serata-giochi") | |

## Features

| English | Italiano | Notes |
|---|---|---|
| Mention | Menzione (verb: menzionare) | |
| Poll | Sondaggio | Vote: "voto", "vota" |
| Teams (team splitter; one team, "Team 1") | Squadre (una squadra, "Squadra 1") | |
| Looking for group (LFG post) | Cerco gruppo ("post LFG" only where short) | |
| Event | Evento | |
| Sticker | Sticker | Invariable, masculine. Never "adesivo" |
| Emoji | Emoji | Invariable, feminine |
| Watch party | Guarda insieme | As a name, also in running text: "in Guarda insieme" |
| Clip | Clip | Invariable, feminine |
| Catch up | Rimettiti in pari | As a name |
| Passkey | Passkey | Invariable, feminine |
| Passphrase | Frase segreta | Never "passphrase" |
| End-to-end encrypted | Crittografia end-to-end; "con crittografia end-to-end" | Adjective where needed: "crittografato end-to-end". Encrypt: "crittografare"; never "criptare" |
| Decrypt | Decifrare | "Impossibile decifrare questo messaggio" |
| Backup | Backup | "Fai un backup", "ripristina un backup" (restore = ripristinare) |

## Terms added for Italian

### General interface

| English | Italiano | Notes |
|---|---|---|
| Cancel | Annulla | |
| Save / Saving… / Saved | Salva / Salvataggio… / Salvato | |
| Close | Chiudi | |
| Edit | Modifica | |
| Done | Fatto | |
| Back / Next / Continue | Indietro / Avanti / Continua | |
| Copy / Copied / Copy link | Copia / Copiato / Copia link | |
| Retry, Try again | Riprova | |
| Loading… | Caricamento… | |
| Create / Add / Send | Crea / Aggiungi / Invia | |
| Apply / Reset / Clear | Applica / Reimposta / Cancella | "Clear" a search or field: "Cancella"; clear a list: "Svuota" |
| Join | Entra (a server, voice channel, call, event) | "Join {{name}}": "Entra in {{name}}". Join a group for a game (LFG), team: "Unisciti" |
| Search | Cerca | Noun: "ricerca" |
| Open | Apri | |
| Undo | Annulla | The action is clear from context (toast button) |
| More | Altro | "{{count}} more": "altri {{count}}" |
| Settings | Impostazioni | |
| On / Off | Attivo / Disattivo | Turn on / off: "Attiva" / "Disattiva" |
| None / Unknown | Nessuno / Sconosciuto | Agree with the noun where it is known |
| Default | Predefinito | |
| Someone | Qualcuno | |
| Choose, pick | Scegli | |
| Show / Hide | Mostra / Nascondi | |
| Turn on / Turn off | Attiva / Disattiva | |
| Allow / Deny | Consenti / Nega | |
| Learn more | Scopri di più | |
| Couldn't… | Impossibile… | "Couldn't send." = "Impossibile inviare." |
| Something went wrong | Qualcosa è andato storto | |
| Hold on, wait a moment | Un attimo… / aspetta un momento | |

### Accounts and security

| English | Italiano | Notes |
|---|---|---|
| Sign in / Sign-in | Accedi / accesso | |
| Create account, sign up | Crea un account | |
| Password | Password | |
| Username | Nome utente | |
| Email | Email | Feminine, no hyphen |
| Two-step sign-in, 2FA code | Accesso in due passaggi, codice | |
| Verify, verification | Verifica | "Verify {{name}}": "Verifica {{name}}" |
| Safety number / fingerprint | Codice di sicurezza | |
| Key (encryption) | Chiave | |
| Trust (a device, a bot) | Considera attendibile; "di cui ti fidi" | "Only run bots you trust": "Avvia solo bot di cui ti fidi" |
| Block / Unblock | Blocca / Sblocca | |
| Friend, friend request | Amico, richiesta di amicizia | "Add friend": "Aggiungi agli amici" |
| Message request | Richiesta di messaggio | |
| Privacy | Privacy | |
| Lock / Unlock (app lock) | Blocca / Sblocca | |

### Chat

| English | Italiano | Notes |
|---|---|---|
| Message | Messaggio | "Message #{{name}}" placeholder: "Scrivi in #{{name}}"; "Message {{name}}": "Scrivi a {{name}}" |
| Reply | Rispondi / risposta | |
| Forward | Inoltra | |
| Reaction | Reazione | |
| Attachment / Attach | Allegato / Allega | |
| Draft | Bozza | |
| Unread | Non letto / "da leggere" | "Mark as read": "Segna come letto" |
| Edited | Modificato | |
| Typing | Sta scrivendo… | |
| Scheduled message | Messaggio programmato | Schedule: "programma" |
| Reminder | Promemoria | Invariable. "Remind me": "Ricordamelo" |
| Bookmark / saved messages | Segnalibro / messaggi salvati | |
| Category | Categoria | |
| Favorites | Preferiti | |
| Spoiler | Spoiler | |
| Link preview / embed | Anteprima del link | |
| Disappearing messages | Messaggi temporanei | |
| Read-only | Sola lettura | |
| Announcement | Annuncio | |
| Follow (a post, a person) | Segui | |
| Subscribe (feed) | Iscriviti | |
| Quiet hours | Ore di silenzio | |
| Alert word | Parola chiave | "{{n}} parole chiave" |
| Do not disturb / Idle / Online / Offline / Invisible | Non disturbare / Assente / Online / Offline / Invisibile | |
| Status, custom status | Stato, stato personalizzato | |
| AFK | AFK | "AFK channel": "canale AFK" |

### Voice and video

| English | Italiano | Notes |
|---|---|---|
| Voice (place) | Vocale ("in vocale", "Abbandona il vocale") | |
| Call, group call | Chiamata, chiamata di gruppo | "{{name}} is calling": "{{name}} ti sta chiamando" |
| Hang up | Riaggancia | |
| Camera | Videocamera | |
| Microphone / Speaker / Headphones | Microfono / Altoparlante / Cuffie | A person speaking on stage: "relatore" |
| Share your screen / screen share | Condividi lo schermo / condivisione schermo | |
| Stream, streamer mode | Diretta, modalità streamer | |
| Recording / Record | Registrazione / Registra | |
| Whisper | Sussurro / Sussurra | |
| Noise suppression | Riduzione del rumore | |
| Volume | Volume | |
| Speaker / audience (stage) | Relatore / pubblico | "Raise hand": "Alza la mano" |
| Captions, transcription | Sottotitoli, trascrizione | |
| Whiteboard | Lavagna | |
| Activity (games in a call) | Attività | |
| Trivia / Draw & guess | Quiz / Disegna e indovina | |
| Pop out | Apri in una finestra | |

### Servers, hosting and bots

| English | Italiano | Notes |
|---|---|---|
| Host (verb), hosting | Ospitare, hosting | "Hosted on this computer": "Ospitato su questo computer" |
| Create a server / Start a server | Crea un server / Avvia un server | |
| Rented server, rental | Server a noleggio, noleggio | |
| Template | Modello | |
| Invite (noun) | Invito | |
| Join questions | Domande d'ingresso | |
| Welcome screen | Schermata di benvenuto | |
| Port, address | Porta, indirizzo | |
| Update / Restart | Aggiornamento, aggiorna / Riavvio, riavvia | |
| Restore | Ripristina | |
| Export / Import | Esporta / Importa | |
| Storage | Spazio di archiviazione | |
| Slash command | Comando | Commands themselves (`/roll`) stay as written |
| Token | Token | Masculine, invariable |
| Feed | Feed | |
| Assistant | Assistente | |
| Doc (shared document) | Documento | |
| Bug report | Segnalazione di bug | "Report a bug": "Segnala un bug" |
| What's new | Novità | |
| Data request, data export (compliance) | Richiesta dei dati, esportazione dei dati | |
| Buddy (game buddies) | Compagno di gioco | |
| Streamer mode | Modalità streamer | |
