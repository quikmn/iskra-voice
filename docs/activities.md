# Activities

Activities are small apps people use together in a voice channel: a game, a quiz, a shared toy. Someone in the call
presses **Activities** in the call controls, picks one, and everyone else in the call sees "Alex started Four in a row —
Join". The activity opens in the call's big spot for everyone who joins.

Iskra comes with three: **Draw & guess**, **Quiz** and **Four in a row**. A server's admins can add their own in
**Server settings → Activities**. This page is about making one.

The wire protocol (what the server checks and relays) is in [PROTOCOL.md → Activities](../protocol/PROTOCOL.md#activities).

## How an activity runs

- **It's a web page in a sealed frame.** It has no network at all: no `fetch`, XHR, WebSocket, WebRTC, images or fonts
  from elsewhere, forms, pop-ups or navigation. It can use its own files, `data:` and `blob:` URLs, canvas, audio
  from its own files, and state in memory (it gets an opaque origin: no cookies, `localStorage` or IndexedDB).
- **It talks only to Iskra**, through the SDK below. Iskra sends what it says to everyone playing, through your server,
  in the same order for everyone (yourself included). Nothing it sends is stored, apart from one snapshot for people
  who join late, kept in the server's memory until the activity ends.
- **It never sees accounts.** Players are an id that is only valid inside this activity session, and a display name.
- **Where it runs:** activities added to a server run in the **Iskra desktop app**, which runs them in a wall where
  nothing can reach the network. Browsers can't be made that tight (a page script can always reach the internet
  through WebRTC in a child frame), so browsers and the phone apps list your activity but don't run it, and say it
  runs in the desktop app. The built-in activities run everywhere: they're part of Iskra.
- **Not in encrypted voice channels:** the server relays what activities send, so they're off there.

## Making one

A zip (up to 5 MB, 200 files, 10 MB unpacked) with at least these two files at the top (or inside one folder):

```
my-activity.zip
├── manifest.json
├── index.html
├── game.js
└── icon.png
```

`manifest.json`:

```json
{
  "name": "Snake duel",
  "description": "Two snakes, one screen.",
  "icon": "icon.png",
  "minPlayers": 2,
  "maxPlayers": 4,
  "version": "1.0",
  "sdk": 1
}
```

Only `name` (1–40 characters) is required. `description` is up to 200 characters, `version` up to 20, players 1–25.

Rules for the files:

- File names use `A–Z a–z 0–9 _ . -`, don't start with a dot, and sit at most 8 folders deep.
- Allowed types: `html htm js mjs css json txt svg png jpg jpeg gif webp ico avif woff woff2 ttf otf mp3 ogg oga wav m4a
  opus`. Text files must be UTF-8.
- **One page:** `index.html` is the activity. It can't navigate to another page.
- **Classic scripts:** use `<script src="game.js">` or inline `<script>`, not `type="module"` (module scripts need
  CORS, which a sealed frame's origin doesn't get). Bundle with any tool into one IIFE file.
- Iskra's server puts two scripts in front of your page: one that removes WebRTC, and the SDK, which defines
  `window.iskra`. You don't need to include anything.

Upload the zip in **Server settings → Activities → Add an activity**. The server checks every file; anything outside
the rules refuses the whole zip, with the reason.

## The SDK (version 1)

```js
const init = await iskra.ready()
// init.me       { id, name }              you, in this activity
// init.players  [{ id, name }, …]         everyone in it, longest-in first
// init.state    the snapshot, or null     what the activity looked like when you joined
// init.locale   'en', 'sv', …             the player's language
// init.theme    { scheme: 'dark' | 'light', colors: { bg, surface, surface2, border, text, muted, accent, green, red, amber } }

iskra.on('message', (data, from, seq) => { … })   // every message, yours too, in the same order for everyone
iskra.on('players', (players) => { … })           // someone joined or left
iskra.on('end', () => { … })                      // the activity is ending

iskra.send(data)       // any JSON, up to 8 KB, to everyone playing
iskra.setState(state)  // a snapshot (any JSON, up to 48 KB) for people who join later
iskra.end()            // ends it for everyone (if you may), else closes it for you

iskra.me               // { id, name }
iskra.players          // [{ id, name }]
iskra.host             // the id of whoever has been in longest
```

Call `iskra.ready()` first and register your `message` listener right after it resolves: messages that arrive before
anyone listens are held and handed over in order.

### Keeping everyone in step

The easy way to build a multiplayer activity on this SDK:

1. Keep all shared state in one object.
2. Write `apply(state, data, from)`: a pure function that returns the next state for a message (or the same state when
   the message isn't valid: out of turn, malformed, from someone who may not do that). Check everything: other
   players' apps send whatever they like.
3. To do anything, `iskra.send()` a message, and change the state only in your `message` listener. Every player
   applies the same messages in the same order, so everyone ends up in the same state, with no host needed.
4. Let `iskra.host` call `iskra.setState(state)` after changes (Iskra sends at most one snapshot every 1.5 s, the
   latest wins). Someone who joins gets that snapshot as `init.state`, then every message after it.

Things only one player's app should know (a word to draw, a quiz's answers) stay in that app until it reveals them in
a message. Never trust data as HTML: put text in with `textContent`.

### Limits

| | |
|---|---|
| A message | 8 KB of JSON; 20 a second (40 in a burst) per player |
| A snapshot | 48 KB of JSON; at most one every 1.5 s |
| Players | 25 at once |
| Messages kept for late joiners | those since the last snapshot, up to 300 and 256 KB |

### The messages underneath

If you'd rather not use the helper: the SDK posts `{ iskra: 1, type: 'ready' | 'send' | 'state' | 'end', … }` to
`window.parent` (in the desktop app's wall, where there is no parent, it writes them as console lines starting with
`\u2063iskra-activity:`), and receives `{ iskra: 1, type: 'init' | 'players' | 'message' | 'ended', … }` as `message`
events. See `protocol/activity-sdk.js`; the app checks every message (`client/src/state/activityHost.ts`).

## A complete example

`index.html`:

```html
<!doctype html>
<html>
<body>
  <button id="go">Press me</button>
  <ol id="log"></ol>
  <script src="game.js"></script>
</body>
</html>
```

`game.js`:

```js
;(async () => {
  const init = await iskra.ready()
  let state = init.state ?? { presses: [] }
  const names = new Map(init.players.map((p) => [p.id, p.name]))
  iskra.on('players', (players) => players.forEach((p) => names.set(p.id, p.name)))

  const render = () => {
    const log = document.getElementById('log')
    log.replaceChildren(...state.presses.map((id) => Object.assign(document.createElement('li'), { textContent: names.get(id) ?? 'Someone' })))
  }

  iskra.on('message', (data, from) => {
    if (data?.t !== 'press' || state.presses.length >= 50) return
    state = { presses: [...state.presses, from] }
    render()
    if (iskra.host === iskra.me.id) iskra.setState(state)
  })

  document.getElementById('go').onclick = () => iskra.send({ t: 'press' })
  render()
})()
```

Zip `index.html`, `game.js` and a `manifest.json` with a name, and add it to your server.

## The built-in ones

`client/src/activities/` holds the three built-ins, written against the same SDK: each is a reducer (`logic.ts`, unit
tested) and a small DOM view (`main.ts`). `client/activities.vite.ts` builds each into one self-contained HTML file.
