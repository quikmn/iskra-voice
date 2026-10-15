# Translation glossary

One word per thing, in every language. Use these terms in the app's texts (`client/src/i18n/en` and `sv`), the
desktop app (`desktop/src/i18n.ts`), the push worker (`client/public/push-sw.js`) and server messages that have a
key. Swedish uses the friendly "du", sentence case in headings and buttons, and a normal Swedish word where one
exists.

## People and places

| English | Svenska | Notes |
|---|---|---|
| Name | Namn | Your Iskra name, everywhere unless a server nickname is set |
| Server nickname | Smeknamn på servern ("Smeknamn på {{server}}" when the server is named) | Optional, only on one server. Reset: "Use my name" / "Använd mitt namn" |
| Owner, Admin, Moderator, Trusted, Member, Guest | Ägare, Admin, Moderator, Betrodd, Medlem, Gäst | Roles; plural "admins" in running text |
| Role, base role | Roll, grundroll | Always "role", never "level"/"nivå". "Base role" only where the built-in one (Owner … Guest) must be told apart from custom roles |
| Built-in role (badge "Built-in") | Inbyggd roll (badge "Inbyggd") | Settings → Roles: Owner … Guest, listed above custom ("egna") roles. Running text elsewhere still says "base role" |
| Bot, bots | Bot, bottar | |
| Server | Server | |
| Channel, text channel, voice channel | Kanal, textkanal, röstkanal | Never "room"/"rum" for a voice channel |
| Stage | Scen | |
| Thread | Tråd | |
| Forum post | Inlägg | |
| Direct messages | Direktmeddelanden | "DM" is fine in short UI text |
| Group DM | Gruppchatt | |
| Device | Enhet | |
| Account | Konto | |

## Settings

| English | Svenska |
|---|---|
| My settings | Mina inställningar |
| Language (section) | Språk |
| Server settings | Serverinställningar |
| Server, Members & safety, Apps, Hosting & data (groups) | Server, Medlemmar och säkerhet, Appar, Drift och data |
| Overview | Översikt |
| Server icon, banner | Serverikon, banderoll |
| Channels | Kanaler |
| Emoji & stickers | Emoji och klistermärken |
| GIFs | GIF:ar |
| Soundboard | Ljudbräda |
| Profile pages | Profilsidor |
| Server rules | Serverregler |
| Members | Medlemmar |
| Roles | Roller |
| Reports | Anmälningar |
| AutoMod (nav and heading) | AutoMod |
| Activity log (who changed what; never "audit log") | Aktivitetslogg |
| Sign-ins & security (never "security log" as a name) | Inloggningar och säkerhet |
| Bots & webhooks | Bottar och webhooks |
| Internet access (section) / Open to the internet (its switch) | Internetåtkomst / Öppna mot internet |
| Limits | Gränser |
| Backup & move | Säkerhetskopia och flytt |
| Import from Discord | Importera från Discord |
| Server updates | Serveruppdateringar |
| Notifications | Aviseringar |
| Recovery key | Återställningsnyckel |
| App lock | Applås |

## Actions

| English | Svenska |
|---|---|
| Invite friends | Bjud in vänner |
| Invite link | Inbjudningslänk |
| Hide server (only off your list) | Dölj servern |
| Leave server (really leaves) | Lämna servern |
| Sign out | Logga ut |
| Kick | Sparka ut |
| Ban, unban | Bannlysa, häva bannlysningen |
| Time out / timeout | Ge timeout / timeout |
| Slowmode | Långsamt läge |
| Mute (yourself) / Deafen | Stäng av mikrofonen / Stäng av ljudet |
| Mute (someone else, for you) / Server mute | Tysta / Servertysta |
| Push to talk | Tryck för att prata |
| Pin, unpin | Fäst, lossa |
| Report (noun) | Anmälan |
| Upload | Ladda upp |
| Preview | Förhandsvisa |
| Delete / Remove | Radera / Ta bort |
| Optional | Valfritt |
| e.g. (example placeholders: "e.g. game-night") | t.ex. ("t.ex. spelkväll") |

## Features

| English | Svenska |
|---|---|
| Mention | Omnämnande (verb: nämna) |
| Poll | Omröstning |
| Teams (team splitter; one team, "Team 1") | Lag (laguppdelning; ett lag, "Lag 1") |
| Looking for group (LFG post) | Söker spelare (inlägget: "LFG-inlägg" only where short) |
| Event | Evenemang |
| Sticker | Klistermärke |
| Emoji | Emoji (no plural ending) |
| Watch party | Titta tillsammans (as a name, also in running text: "i Titta tillsammans") |
| Clip | Klipp |
| Catch up | Kom ikapp |
| Passkey | Lösenordsnyckel |
| Passphrase | Lösenfras |
| End-to-end encrypted | Totalsträckskrypterad |
| Decrypt | Dekryptera |
| Backup | Säkerhetskopia |

## Server messages

The server writes its errors in English with a `key` and `args` (see `protocol/PROTOCOL.md` → Errors); the app
translates them in `errors.server` of each catalog. Pushes name their texts the same way (`text`), and the push
worker holds the Swedish for them. Tests check that every key the server can send has a text in every language and
that the English text matches the server's own (`client/src/i18n/serverErrors.test.ts`).
