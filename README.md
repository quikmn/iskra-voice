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
- **Easiest:** install the [Windows app](https://github.com/quikmn/iskra-voice/releases) and click **Create a server**. It runs on your PC with voice included, and you're the owner. Turn on **Open to the internet** and friends anywhere can join, in the browser too. Click **Invite friends** and send the link.
- **Always on, at home or on a VPS:** download the server for Windows or Linux, run `iskra-server my-server`, and open the owner link it prints. See the [hosting guide](docs/hosting.md).

## What's in it

- **Text channels:** Markdown, @mentions, replies, reactions, edits, uploads up to 100 MB (no Nitro needed), images and video inline, link previews, unread and mention badges.
- **Threads, pins and search:** side conversations off any message, pinned messages per channel, and fast search with filters that jumps straight to the result.
- **Polls, custom emoji and a soundboard:** server emoji in messages and reactions, quick polls, and short sounds everyone in voice hears.
- **Voice channels:** low-latency voice for big groups (LiveKit), push-to-talk that works while a game has focus, per-person volume, camera and 1080p screen sharing with sound.
- **Friends, DMs and calls:** DMs and voice and video calls are end-to-end encrypted, and DMs have forward secrecy. Compare safety numbers to be sure who you're talking to.
- **Profiles your way:** avatar, bio, pronouns and an accent colour, plus your own profile page in HTML, safely sandboxed. Eleven themes, or write your own in JSON.
- **Bots and webhooks:** Discord-compatible webhooks (GitHub too) and a small Node SDK for bots.
- **Roles and moderation:** private and read-only channels, invite links with expiry or single use, kick and ban.
- **Your account is a key on your devices.** Link a phone by scanning a QR code, see your devices, and remove any of them.
- **One-click internet hosting:** Iskra opens the ports on your router, gets a free address and sets up HTTPS by itself.
- **Your server is a folder.** Copy it to back it up or move it.
- **Everywhere:** Windows app with auto-update, and a web app for PCs and phones that installs like an app and sends push notifications.

How privacy works, and what a server can and can't see: [docs/security.md](docs/security.md).

## Coming next

- **Mac and Linux apps** with the next release (the builds are ready). The first macOS builds aren't notarized by Apple yet.
- **Group DMs and group calls.** DMs and calls are one-to-one for now.
- **Native phone apps.** Until then, the web app installs to your home screen.
- **DMs with people you share no server with.**

## For developers

- [Development guide](docs/development.md): layout, running locally, tests, builds.
- [Protocol](protocol/PROTOCOL.md): everything the server and clients say to each other.
- Built with C# / .NET 10, TypeScript / React, Electron, LiveKit and libsodium.


## License

[PolyForm Noncommercial 1.0.0](LICENSE): free to use, host and modify for any noncommercial purpose.

Like it? [Buy me a coffee on Ko-fi](https://ko-fi.com/vlundgren).
