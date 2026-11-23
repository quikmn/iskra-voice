# Translating Iskra

How to add an interface language, or work on one. English is the source: every text is written in English first
(`client/src/i18n/en/`), and English shows wherever a language has no text.

## What a language consists of

For a language with the code `<code>` (two or three lower-case letters: `de`, `pt`):

| What | Where | Without it |
|---|---|---|
| The line in the language list | `client/src/i18n/languages.ts` | The language doesn't exist |
| The app's texts (the catalog) | `client/src/i18n/<code>/` | Required: the tests fail |
| Desktop app texts (tray, file pickers, splash) | `desktop/src/text/<code>.ts` | English |
| Push notification texts | `client/public/push-text/<code>.js` | English |
| Quiz questions | `client/src/activities/trivia/questions/<code>.ts` | English |
| Words for Draw & guess | `client/src/activities/draw/words/<code>.ts` | English |
| Glossary | `docs/i18n/glossary-<code>.md` | See [Glossary](#glossary) |

The line in `languages.ts` is the only edit to a file that other languages share. Everything else is a new file that is
found by its name, so nothing else needs to be registered.

Not translated per language yet (English, some also Swedish): the invite page and the exported channel pages the
server writes, the "What's new" notes, the website and the store listings.

## Adding a language, step by step

1. **The list.** Add one line to `LANGUAGE_REGISTRY` in `client/src/i18n/languages.ts`, sorted by code:

   ```ts
   { code: 'de', name: 'Deutsch', locale: 'de-DE', shipped: true },
   ```

   `name` is the language's own name, as the picker shows it. `locale` is used for dates and numbers when the
   system's own locale isn't in this language (`pt` → `pt-BR`). `shipped: false` keeps the language out of the picker
   and out of "Automatic" while it is being worked on; it still loads when asked for by code (the tour does that).

   | Code | Name | Locale |
   |---|---|---|
   | `de` | Deutsch | `de-DE` |
   | `es` | Español | `es-ES` |
   | `fr` | Français | `fr-FR` |
   | `it` | Italiano | `it-IT` |
   | `pl` | Polski | `pl-PL` |
   | `pt` | Português (Brasil) | `pt-BR` |
   | `ru` | Русский | `ru-RU` |

2. **The catalog.** Copy `client/src/i18n/sv/` to `client/src/i18n/<code>/` (the Swedish folder has the typed file
   layout; translate from the English texts in `en/`, file by file). In `<code>/index.ts`, rename the export to the
   code: `export const de: Messages = { … }`. Every file is `export const <area>: Messages['<area>'] = { … }`, so the
   compiler reports a missing or extra key.

3. **Desktop.** Copy `desktop/src/text/sv.ts` to `desktop/src/text/<code>.ts` and translate from `en.ts`. Some texts
   are functions (`` (version) => `Downloading ${version}…` ``): keep the arguments, move them where the sentence
   needs them.

4. **Push notifications.** Copy `client/public/push-text/en.js` to `<code>.js` and translate the values. The names
   and `{{variables}}` stay. See [Plurals](#plurals) for the texts that count something.

5. **Activities.** `questions/<code>.ts`: the same number of questions as `en.ts`, each with 2–4 different options
   and `correct` pointing at the right one. Translate them, or replace a question that only makes sense in English
   with one that works in your language. `words/<code>.ts`: more than 80 everyday things to draw, lower case, no
   duplicates, at most 40 characters; pick words that work in your language instead of translating one by one.

6. **Glossary.** Write `docs/i18n/glossary-<code>.md` before translating the bulk, and keep to it.

7. **Check**, then **look at it** (both below).

## How the catalog is laid out

- One file per area (`chat.ts`, `settings.ts`, `errors.ts`, …), nested objects, the same in every language. A text's
  key is its path: `chat.view.members`.
- `errors.ts` holds the server's messages (`errors.server.<key>`, `errors.codes.<code>`). The server sends English
  with a key; the app shows the catalog's text for that key.
- `activities.ts` is also built into the games, which run in their own frame.
- Comments in `en/` say where a text is used when it isn't obvious. Read them; they don't need translating.
- Don't add, remove or rename keys. A new text starts in `en/`.

## Variables and tags

- `{{name}}` is replaced with a value. Keep every variable exactly as written, and move it where the sentence needs
  it. The value is inserted as it is: a person's name isn't declined, a number isn't spelled out. Word the sentence
  so that works ("{{name}} joined" may need a neutral form where the verb would show gender).
- `<b>...</b>`, `<a>...</a>`, `<code>...</code>`, `<name>...</name>` mark a part that becomes bold text, a link, a
  button or a styled name. Keep the same tags around the words that play that part in your language. Don't add,
  remove or rename tags.
- Keep leading and trailing spaces as in English (a few texts are joined to others).
- Some texts are parts of a sentence or a list ("and {{count}} more"). Check the neighbouring keys to see what they
  are joined with.
- `…` is one character (U+2026), not three dots. Use your language's quotation marks and dashes.

The tests compare the variables and tags of every text with the English one.

## Plurals

A text that counts something has one key per plural form: `members_one`, `members_other`. The app picks the form
with the browser's `Intl.PluralRules` for the language and `{{count}}`.

| Language | Forms the catalog must have | Notes |
|---|---|---|
| `en`, `sv`, `de` | `_one`, `_other` | |
| `es`, `it` | `_one`, `_other` | `_many` is optional (see below) |
| `fr`, `pt` | `_one`, `_other` | `_one` is used for 0 and 1; `_many` is optional |
| `ru` | `_one`, `_few`, `_many`, `_other` | `_one`: 1, 21, 31…; `_few`: 2–4, 22–24…; `_many`: 0, 5–20, 25–30…; `_other`: fractions (1.5) |
| `pl` | `_one`, `_few`, `_many`, `_other` | `_one`: only 1; `_few`: 2–4, 22–24…; `_many`: 0, 5–21, 25–31…; `_other`: fractions |

- The rule: a catalog must have every form that a whole number from 0 to 200 can pick in the language, plus `_other`.
  It may not have a form the language never uses (`_few` in German).
- `_many` in Spanish, French, Italian and Portuguese is only asked for at exactly 1,000,000, 2,000,000 and so on
  (newer browsers; Node 24 and Chromium agree). Leave it out unless the wording really differs ("1 000 000 de
  mensajes"): the app then uses `_other`.
- A form that is missing shows the language's own `_other`, never English. (i18next alone would fall back to
  English; `withPluralForms` in `languages.ts` fills the forms in when a catalog loads.)
- `_one` may leave out `{{count}}` ("one message") only where that form means exactly 1: English, Swedish, German,
  Spanish, Italian, Polish. In Russian (21, 31), French and Portuguese (0) `_one` must contain `{{count}}`.
- Where English has `_one` and `_other`, add your extra forms next to them with the same base name:
  `members_one`, `members_few`, `members_many`, `members_other`.
- Push texts (`push-text/<code>.js`) use an object for the same thing:
  `{ one: '{{n}} упоминание', few: '{{n}} упоминания', many: '{{n}} упоминаний', other: '{{n}} упоминания' }`.
  Any text there that counts (`dmCount`, `groupCount`, `more`, everything under `digest`) may be a plain string or
  such an object.
- The desktop texts have no plurals.

## Tone and style

- Plain, friendly and positive, like a casual chat app in your language. Short sentences. No jargon where a normal
  word exists; say what the person can do next instead of what went wrong.
- Address the person the same way everywhere. Choose once (informal or formal "you") and write the choice at the top
  of your glossary. A casual chat app for friend groups is normally informal: German "du", Spanish "tú", French
  "tu", Italian "tu", Portuguese "você", Polish second person singular. For Russian, choose between "ты" and "вы"
  and keep to it. Avoid wording that assumes the person's gender.
- Sentence case for headings, buttons and menu items, as in the English texts ("Invite friends", "My settings"):
  capitalise the first word and what your language's spelling rules capitalise (German nouns, proper names), nothing
  else. No English-style Title Case.
- "Iskra" is never translated or transliterated: it stays "Iskra" in Latin letters. Product and brand names stay as they
  are (Discord, DigitalOcean, Tailscale, GitHub), and so do `AutoMod` and file formats.
- Use the word your glossary gives for a thing, every time. Use an established term in your language where there is
  one (what other chat apps call a server, a channel, a thread), not a new coinage.
- Keep texts about as long as the English ones. Buttons, tabs, menu items, sidebar entries and dialog titles have
  little room: prefer the shorter word there. The tour shows what doesn't fit.
- Follow your language's typography (spaces before `?` `!` `:` in French, `„…“` in German, «…» in Russian).
- Don't translate: keys, `{{variables}}`, tag names, URLs, slash commands (`/roll`), key names (`Ctrl`, `Esc`),
  code and file names.

## Glossary

`docs/i18n-glossary.md` is the English and Swedish glossary. Each new language has its own file,
`docs/i18n/glossary-<code>.md`, with:

1. A short head: the form of address chosen, the case rule, typography rules, anything decided for the whole
   language.
2. The same sections and the same English terms as `docs/i18n-glossary.md`, in the same order, as tables:

   ```md
   ## People and places

   | English | Deutsch | Notes |
   |---|---|---|
   | Server | Server | |
   | Channel, text channel, voice channel | Kanal, Textkanal, Sprachkanal | Never "Raum" for a voice channel |
   ```

Every English term in `docs/i18n-glossary.md` gets a row. Add rows for terms you had to decide that aren't there.
The catalog, the desktop texts, the push texts and the activities all use the glossary's words.

## Checks

```sh
cd client
npm run test:i18n     # the language checks only: a few seconds
npx tsc -b            # the compiler: missing or extra keys
cd ../desktop
npm test              # desktop texts (and the rest of the desktop tests)
```

Before handing over: `cd client && npm test && npm run build`, and `cd desktop && npm test`.

What the checks cover, for every language in the list:

- The catalog has exactly the keys English has, with the plural forms from the table above and no others.
- No empty text; the same `{{variables}}` and `<tags>` as English; spaces at the ends only where English has them;
  "Iskra" kept; `{{count}}` in `_one` where it is needed.
- The right plural form is shown for 0, 1, 2, 5, 21, 22, 100 and 1.5, through i18next itself.
- Desktop texts: every text, none empty, the same arguments, "Iskra" kept.
- Push texts: the same names and variables as `en.js`, the plural forms the language needs.
- Questions and words: the counts and limits in step 5.
- The list itself: a known locale, a catalog folder for every line and a line for every folder.

The checks can't tell whether a translation is right or reads well. Read your texts in the app.

## Looking at it: the language tour

The tour opens the main screens in one language at desktop width (1280×800) and phone width (390×844) and saves a
screenshot of each: first run, an invite, a server with its channel list and chat, the message menu, dialogs (invite
friends, create channel, join or start a server, events), a voice call and the voice bar, every section of My settings
and of Server settings. About 125 screenshots in two minutes.

```sh
cd client
dotnet build ../server/src/Iskra.Server        # once, and after server changes
ISKRA_UI_LANG=de ISKRA_E2E_PORT=5441 npx playwright test e2e/language-tour.spec.ts --workers=1 --retries 0
```

PowerShell: `$env:ISKRA_UI_LANG='de'; $env:ISKRA_E2E_PORT='5441'; npx playwright test e2e/language-tour.spec.ts --workers=1 --retries 0`

- Output: `client/e2e/screenshots/lang-<code>/` (not committed): `NN-name-desktop.png`, `NN-name-phone.png`,
  `findings.txt` and `findings.json`.
- `findings.txt` lists text that fits in English but not in your language on that screenshot: `cut with …`,
  `cut off`, `pokes out of its box`, `runs off the screen`, `page scrolls sideways`. `cut with …` is often fine for
  names and long values; the others need a shorter text or a layout fix. Look at the screenshots too: a finding list
  doesn't see an awkward line break.
- `ISKRA_TOUR_ONLY=first-run,settings` runs only the parts whose names start with those words (`first-run`,
  `invite`, `server`, `server-chat`, `server-dialogs`, `voice`, `settings-mine`, `settings-server`).
- `ISKRA_UI_LANG=pseudo` is English with every word about 35% longer. Use it after a layout change to see whether
  long words fit, without a translation.
- Use your own port (`ISKRA_E2E_PORT`) when several people or agents run it on one machine. The voice shots need
  LiveKit in `.tools` (`scripts/get-livekit.ps1`); without it they are skipped.
- The tour clicks around in English and switches language for each screenshot, so it needs no changes for a new
  language. It needs the language's line in `languages.ts` (`shipped: false` is enough).

To use the app in a language that isn't shipped yet: run `.\dev.ps1`, and in the browser console
`localStorage.setItem('iskra.language', '<code>')`, then reload.
