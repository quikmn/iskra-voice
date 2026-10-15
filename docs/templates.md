# Server templates

A template sets up a new Iskra server in one go: channels of every kind, who can see and use each one, roles, what the
built-in roles can do, rules, the AFK channel and server settings, and even some starting content: channel topics,
welcome messages and docs pages. It's a small JSON file you can read and edit.

- **In the desktop app:** **Create a server**, then pick a starting point: *Gaming group*, *Friends hangout*, *Board
  games and tabletop*, *Empty*, or **From a template file…**. You see everything a template sets up before anything is
  created.
- **Save your own:** **Server settings → Overview → Save as template** (admins). The file has your channels (with their
  topics and disappearing-message timers), who can see and use them, roles, rules and settings. It never has members,
  messages, docs pages, files, invites or keys. Channels you can't
  see yourself are left out. Encrypted channels are saved as ordinary channels, because a template can't hold keys:
  turn encryption on again after creating the server.
- **Standalone server:** `iskra-server my-server --template gaming`, `--template ./book-club.json`, or
  `"Template": "./book-club.json"` in `server.json` before the first start. A relative file is looked for in the
  server's folder first.
- **Check a file:** `iskra-server templates ./book-club.json` prints what it would set up, or exactly what's wrong.
  `iskra-server templates` lists the built-in ones.

A template is applied **once**, on the first start of a new server (nobody has joined, nothing set up yet). On a server
that's already in use it's ignored, so a leftover setting never adds channels to it. A bad template stops the server
from starting, with a message saying what to fix. Applying one is written to the security log.

## Adding a template to a server in use

```
iskra-server templates apply <world-folder> <template.json>           # shows what it would add
iskra-server templates apply <world-folder> <template.json> --apply   # adds it
```

Stop the server first (the command refuses while it runs). This only **adds**: roles and categories the server doesn't
have (by name), channels it doesn't have (by name and kind, anywhere on the server), and settings that are still at
their defaults (a colour or powers for a built-in role nobody changed, rules if there are none, the AFK channel if none
is set, the default notifications, limits, built-in bots, the bug inbox, translation). A channel it already has gets
the template's starting content only where it has none yet: a topic if it has none, the template's messages if the
template never posted there, docs pages whose titles it doesn't have, and a disappearing-messages timer if none was ever
set. It never deletes, renames or changes channels, roles, members or messages that are there. Running it twice adds
nothing the second time.

The bug inbox is left off (the command says so) if the server's channel of that name can be read by more people than
the template says: reports can hold email addresses. It is also left off, with a message, on a server that doesn't take
bug reports (`BugInbox.Accept` in server.json is off, which is the default: only the server that receives Iskra's
bug reports turns it on).

## The format

```jsonc
{
  "version": 3,                                // 3 for this format; 2 and 1 (no version) still work
  "name": "Book club",                         // 1–60 characters
  "description": "Reading together.",          // optional, up to 300
  "channels": [                                // optional: outside any category, listed first
    { "name": "welcome", "writeRole": "admin", "topic": "Start here",
      "messages": [{ "text": "# Welcome!\nGrab a book and say hi in **#now-reading**.", "pin": true }] }
  ],
  "categories": [                              // optional, up to 50
    {
      "name": "Books",                         // 1–32 characters
      "channels": [
        { "name": "now-reading", "slowmode": 30 },
        { "name": "announcements", "writeRole": "admin",
          "overrides": [{ "role": "Moderator", "allow": ["send"] }] },
        { "name": "mod-room", "readRole": "admin",
          "overrides": [{ "role": "Moderator", "allow": ["view", "send"] }] },
        { "name": "reviews", "kind": "forum", "tags": [{ "name": "Fiction", "emoji": "📖" }, { "name": "Non-fiction" }] },
        { "name": "reading-list", "kind": "docs",
          "pages": [{ "title": "How we pick books", "text": "We vote every month…", "startHere": true }] },
        { "name": "spoilers", "disappear": 86400 }
      ]
    },
    {
      "name": "Voice",
      "channels": [
        { "name": "Reading room", "kind": "voice", "userLimit": 8 },
        { "name": "Listening party", "kind": "voice", "hifi": true },
        { "name": "Author talk", "kind": "stage" },
        { "name": "AFK", "kind": "voice" }
      ]
    }
  ],
  "roles": [                                   // optional, up to 100, highest first
    { "name": "Moderator", "color": "#3fa66b", "icon": "📚", "hoist": true, "mentionable": false,
      "permissions": ["manageMessages", "timeoutMembers", "kickMembers", "muteMembers", "moveMembers", "viewAuditLog"] }
  ],
  "builtinRoles": {                            // optional: owner, admin, trusted, member, guest
    "owner": { "color": "#c27ce0" },
    "admin": { "color": "#e5534b" },
    "member": { "abilities": ["invite", "events", "pin"] }   // the whole set; left out: the defaults
  },
  "rules": { "text": "Be kind.", "welcome": "Welcome!", "required": false },
  "afk": { "channel": "AFK", "minutes": 30, "canTalk": ["owner", "admin", "Moderator"] },
  "settings": {
    "notifyDefault": "auto",                   // "auto" (all messages under 15 people), "all" or "mentions"
    "limits": { "maxUploadMb": 512, "guestMbPerDay": 1024, "emojiMaxKb": 1024 },
    "builtinBots": ["dice", "polls", "reminders"],
    "bugInbox": "mod-room",                    // a text channel of the template: bug reports land there
    "translation": true                        // offer message translation to members
  }
}
```

Comments and trailing commas are fine. Unknown fields are an error, so typos don't go unnoticed; a file made by a newer
version of Iskra says so. Files can be up to 256 KB, with up to 500 channels.

### Channels

| field | meaning |
|---|---|
| `name` | 1–32 characters |
| `kind` | `text` (default), `voice`, `forum`, `stage`, `docs` or `whiteboard` |
| `readRole` | the lowest built-in role that can see it: `guest`, `member` (default), `trusted`, `admin` or `owner` |
| `writeRole` | the lowest built-in role that can post (text, forums), speak (voice), ask to speak (stage), edit (docs) or draw (whiteboards). Default: the same as `readRole`; for docs `trusted` |
| `overrides` | for the template's own roles: `{ "role": "Moderator", "allow": [...], "deny": [...] }` with `view`, `send`, `connect`, `speak`. Denies apply first, then allows |
| `userLimit` | voice only: 0 (no limit) to 99 |
| `hifi` | voice only: hi-fi audio allowed |
| `slowmode` | seconds between messages per person: 0 (off), 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200 or 21600. Not for docs or whiteboards |
| `tags` | forums only: up to 20, `{ "name": "Bug", "emoji": "🐛" }` |
| `topic` | one line saying what the channel is for, shown at its top: up to 300 characters |
| `messages` | text channels only: up to 10 messages, `{ "text": "...", "pin": true }`, posted once under the server's name. Markdown as in the app, up to 4000 characters each; mentions never ping |
| `pages` | docs channels only: up to 20 pages, `{ "title": "...", "text": "...", "startHere": true }`. Markdown as in docs, up to 100 KB each. One page in the whole template can be the server's **Start here** page |
| `disappear` | text and voice channels: messages disappear after this many seconds: 0 (off), 300, 3600, 28800, 86400, 604800 or 2419200. Not together with `messages` |

The server's starting `#general` becomes the template's first text channel. A template has at most 100 messages and 50
pages in all. Messages and pages are plain text in the app's Markdown: they're shown like any message or page, never
run as code.

### Roles

`roles` are custom roles. Names can't be `everyone` or a built-in role's. Permissions: `manageMessages`,
`timeoutMembers`, `kickMembers`, `banMembers`, `manageChannels`, `manageRoles`, `viewAuditLog`, `manageExpressions`,
`manageWebhooks`, `mentionEveryone`, `moveMembers`, `muteMembers`, `manageAutoMod`.

`builtinRoles` sets a built-in role's `color` (`#rrggbb`, or `""` for none) and, optionally, what it can do:
`abilities` and `permissions`, each the whole set (left out: the defaults, the same as in **Server settings → Roles**).
Abilities: `invite`, `events`, `pin`, `mentionEveryone`, `uploadSounds`, `giveBaseRoles`, `bots`, `organize`, `rules`,
`stickers`, `gifs`, `stageModerators`, `forumTags`, `profilePages`, `resolveDisputes`, `serverImages`. The same safety rules apply as in
the app: the owner's powers never change, `runServer` and `transferOwnership` stay the owner's, and guests and members
only get everyday powers (`invite`, `events`, `pin`, `mentionEveryone`, `uploadSounds`, and the permission
`mentionEveryone`).

### Rules and the AFK channel

- `rules`: `text` up to 6000 characters, `welcome` up to 500; `required` makes members agree before they can write
  (needs `text`).
- `afk`: `channel` names one of the template's voice channels; people idle in voice for `minutes` (5, 15, 30 or 60;
  0 = never move anyone; default 30) are moved there. Everyone in it is muted and deafened by the server except the
  built-in roles and template roles (by name) in `canTalk` (default `["owner", "admin"]`).

### Settings

- `notifyDefault`: what people who chose nothing get: `auto`, `all` or `mentions`. Admins can change it later in
  their notification settings for the server.
- `limits`: any of `maxUploadMb` (1 or more), `memberMbPerDay`, `guestMbPerDay`, `soundMaxSeconds`, `soundMaxMb`,
  `emojiMaxKb`, `stickerMaxKb` (0 = no limit). Left out: the server's defaults.
- `builtinBots`: built-in bots to turn on: `dice`, `polls`, `reminders`.
- `bugInbox`: a text channel of the template where bug reports from Iskra apps land (normally only useful on the
  server that runs the bug inbox). Applied only when that server's `server.json` has `"BugInbox": { "Accept": true }`;
  on any other server it is skipped with a message, and a saved template leaves it out.
- `translation`: `true` offers message translation to members (Server settings → Translation): the server fetches each
  language's model from Mozilla the first time a member needs it.

## The built-in templates

- **Gaming group:** announcements (admins and moderators post), general, clips, looking-for-group (slowmode), a
  moderators' channel, Lobby, Squad and Raid voice channels with limits, a Tournament stage and an AFK channel;
  Moderator and Raid lead roles; Dice and Polls on.
- **Friends hangout:** general, photos, memes, a *plans* forum with tags, voice channels and an AFK channel; members can
  pin; Polls and Reminders on.
- **Board games and tabletop:** campaign notes as a docs channel (game masters edit), a private GM screen, tables with
  limits and a hi-fi music room; Moderator and Game master roles; Dice on.
- **Empty:** #general and one voice channel.
