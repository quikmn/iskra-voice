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

> **Iskra 2 is in alpha.** It's the whole app rebuilt from the ground up: more secure, faster and easier. Expect rough edges, and tell us what you find.

## Get started

**Join friends:** open their invite link. Pick a name and you're in: no email, no password, no signup.

**Start your own server:**
- **Easiest:** install the [Windows app](https://github.com/quikmn/iskra-voice/releases) and click **Create a server**. It runs on your PC with voice included, and you're the owner. Click **Invite friends** and send the link.
- **Always on, at home or on a VPS:** download the server for Windows or Linux, run `iskra-server my-server`, and open the owner link it prints. See the [hosting guide](docs/hosting.md).

## What's in it

- **Text channels:** Markdown, @mentions, replies, reactions, edits, uploads up to 100 MB (no Nitro needed), images and video inline, link previews, unread and mention badges, desktop notifications.
- **Voice channels:** low-latency voice for big groups (LiveKit), push-to-talk that works while a game has focus, per-person volume, camera and 1080p screen sharing with sound.
- **Friends and direct messages:** DMs are end-to-end encrypted. Compare safety numbers to be sure who you're talking to.
- **Roles and moderation:** private and read-only channels, invite links with expiry or single use, kick and ban.
- **Your account is a key on your device.** Save your recovery key to bring it to another device.
- **Your server is a folder.** Copy it to back it up or move it. Automatic HTTPS with Let's Encrypt is built in.
- **Everywhere:** Windows app, and a web app that works on PCs and phones.

How privacy works, and what a server can and can't see: [docs/security.md](docs/security.md).

## Coming next

One-click internet hosting from the app, Mac and Linux apps, voice calls in DMs, custom profile pages and themes, then favourites from Iskra 1: threads, pins, search, polls, custom emoji, soundboard, bots and webhooks.

## For developers

- [Development guide](docs/development.md): layout, running locally, tests, builds.
- [Protocol](protocol/PROTOCOL.md): everything the server and clients say to each other.
- Built with C# / .NET 10, TypeScript / React, Electron, LiveKit and libsodium.

Looking for Iskra 1? It lives on the [`v1` branch](https://github.com/quikmn/iskra-voice/tree/v1).

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free to use, host and modify for any noncommercial purpose.

Like it? [Buy me a coffee on Ko-fi](https://ko-fi.com/vlundgren).
