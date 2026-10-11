<p align="center"><img src="client/public/favicon.svg" width="72" alt=""></p>

<h1 align="center">Iskra</h1>

<p align="center"><strong>Voice and text chat for your friends, on a server you own.</strong><br>
Free, no ads, no tracking, no paywalls. Your server is a folder you can copy.</p>

<p align="center">
  <a href="https://github.com/quikmn/iskra-voice/releases"><b>Download</b></a> ·
  <a href="https://app.iskra.foo"><b>Open in your browser</b></a> ·
  <a href="https://iskra.foo">iskra.foo</a>
</p>

---

> **Iskra is in alpha.** Expect rough edges, and tell us what you find.

## Get started

**Join friends:** open their invite link. Pick a name and you're in: no email, no password, no signup.

**Start your own server:**
- **Easiest:** install the [desktop app](https://github.com/quikmn/iskra-voice/releases) (Windows, macOS or Linux) and click **Create a server**. It runs on your PC with voice included, and you're the owner. Turn on **Open to the internet** and friends anywhere can join, in the browser too. Click **Invite friends** and send the link.
- **Always on, at home or on a VPS:** download the server for Windows, Linux or macOS, run `iskra-server my-server`, and open the owner link it prints. See the [hosting guide](docs/hosting.md).

## What's in it

- **Text channels:** Markdown with headings, lists and highlighted code, spoilers, @mentions for people and roles, replies, reactions, edits, forwarding, drafts, message links and "mark unread", voice messages, uploads up to 512 MB by default (no Nitro needed; the owner sets the limits) with a gallery view, link previews, and unread markers and badges that always agree.
- **Forums and events:** forum channels for questions and plans, with tags, search and "new" markers; scheduled events with reminders, "Interested" and add to calendar.
- **Threads, pins and search:** side conversations off any message, pinned messages per channel, and fast search with filters that jumps straight to the result.
- **Polls, custom emoji, stickers, GIFs and a soundboard:** server emoji and stickers, a GIF picker (KLIPY), quick polls, and a soundboard with sounds of any length.
- **Voice channels:** low-latency voice for big groups (LiveKit), strong noise suppression, push-to-talk and mute/deafen keybinds that work while a game has focus, per-person volume, user limits per channel, camera and 1080p screen sharing with sound.
- **Stages and watch parties:** listen-only rooms where moderators bring people up to speak, and video links, uploads or YouTube watched in step by everyone in voice.
- **Friends, DMs, group chats and calls:** friend requests like on Discord (right-click anyone; requests are end-to-end encrypted and signed, so servers never see your friends list). DMs (with pictures, files and voice messages), group chats of up to ten and voice and video calls, one-to-one or in a group, are all end-to-end encrypted, and DMs have forward secrecy. Compare safety numbers to be sure who you're talking to.
- **Status and activity:** online, idle, do not disturb or invisible, a custom status, and "Playing X" from the desktop app if you turn it on.
- **Organized your way:** channel categories, server folders, notification levels and mutes per channel or server, nicknames, unread navigation and keyboard shortcuts.
- **Profiles your way:** avatar, bio, pronouns and an accent colour, plus your own profile page in HTML, safely sandboxed. Eleven themes, or write your own in JSON.
- **Bots and webhooks:** Discord-compatible webhooks (GitHub too) and a small Node SDK for bots.
- **Roles and moderation:** custom roles with permissions, colours and per-channel overrides, private and read-only channels, invite links with expiry or single use, blocking, timeouts, slowmode, server mute, kick, ban and an audit log. AutoMod blocks words, spam, mention spam and invite links, and server rules greet new members, who agree before they chat.
- **Your account is a key on your devices,** stored encrypted, with an optional app lock. Link a phone by scanning a QR code, see your devices, remove any of them, and replace your account key if it ever leaks.
- **One-click internet hosting:** Iskra opens the ports on your router, gets a free address and sets up HTTPS by itself.
- **Your server is a folder,** with daily backups. Download an encrypted backup, restore it anywhere and move your members along, or import your Discord server's history.
- **Everywhere:** apps for Windows, macOS, Linux and Android, auto-update, a tray and iskra:// invite links, and a web app for PCs and phones that installs like an app (on iPhone too) and sends push notifications.
- **In English and Swedish,** following your system language or your pick in Settings.

How privacy works, and what a server can and can't see: [docs/security.md](docs/security.md).

## Coming next

- **An iPhone app in the App Store.** Until then, the web app installs to your Home Screen.
- **DMs with people you share no server with.**

## For developers

- [Development guide](docs/development.md): layout, running locally, tests, builds.
- [Protocol](protocol/PROTOCOL.md): everything the server and clients say to each other.
- Built with C# / .NET 10, TypeScript / React, Electron, LiveKit and libsodium.


## License

[PolyForm Noncommercial 1.0.0](LICENSE): free to use, host and modify for any noncommercial purpose.

Like it? [Buy me a coffee on Ko-fi](https://ko-fi.com/vlundgren) or [donate with PayPal](https://paypal.me/iskrafoo).
