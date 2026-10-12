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

## Why Iskra

- **Free, for real.** Nothing is behind a paywall: big file uploads, screen sharing at full resolution and 60 fps, the soundboard, profiles and themes are there for everyone. No ads, no tracking, no tiers.
- **Your server, your data.** Your group's server runs on a computer you choose, and everything lives in one folder you can back up, move or delete. Members' apps talk to their own server, not to us.
- **Donations only.** If you like it, you can [buy me a coffee](https://ko-fi.com/vlundgren) or [donate with PayPal](https://paypal.me/iskrafoo). You never have to.

## Get started

**Join friends:** open their invite link. Pick a name and you're in: no email, no password, no signup.

**Start your own server:**
- **Easiest:** install the [desktop app](https://github.com/quikmn/iskra-voice/releases) (Windows, macOS or Linux) and click **Create a server**. Pick a name and a starting point (*Gaming group*, *Friends hangout*, *Board games and tabletop* or *Empty*), and you own a server with channels, voice rooms, roles and rules, running on your PC with voice included. Tick **Keep my server running** and it starts with your computer. Turn on **Open to the internet** and friends anywhere can join, in the browser too; if your connection can't host, the app tells you why and what you can do. Click **Invite friends** and send the link.
- **Always on, without your PC:** **Rent a small server** from the app. It gives you a setup text to paste at a VPS provider you pick, and you become the owner right from the app, no terminal needed. Or download the server for Windows, Linux or macOS, run `iskra-server my-server`, and open the owner link it prints.

Everything step by step, including port forwarding and carrier-grade NAT: the [hosting guide](docs/hosting.md).

## What's in it

- **Text channels:** Markdown with headings, lists and highlighted code, spoilers, @mentions for people and roles, replies, reactions, edits with an edit history, forwarding, drafts, message links and "mark unread", voice messages, uploads up to 512 MB by default (the owner sets the limits) with a gallery view, link previews, and unread markers and badges that always agree.
- **Saved messages, reminders and send later:** save any message, get reminded about it later, schedule a message for a set time, and find your mentions and replies in the inbox. **Catch up** sums up what you missed, worked out on your own device.
- **Forums, events and docs:** forum channels with tags, search and "new" markers; scheduled events with reminders, "Interested" and add to calendar; docs channels for guides, FAQs and notes, with page history and search.
- **Threads, pins and search:** side conversations off any message, pinned messages per channel, and fast search with filters that jumps straight to the result.
- **Polls, custom emoji, stickers, GIFs and a soundboard:** server emoji and stickers, a GIF picker (KLIPY), quick polls, and a soundboard with sounds of any length.
- **Voice channels:** low-latency voice for big groups (LiveKit) with a text chat in every voice channel, push-to-talk and mute/deafen keybinds that work while a game has focus, per-person volume, user limits per channel, and camera and screen sharing with sound, at your screen's own resolution and 60 fps by default. Save a **clip** of the last seconds of a call; it's recorded on your own device, and everyone can see who has clips on.
- **Sound that just works:** AI noise removal (DeepFilterNet3), voice detection that doesn't cut off your first word (Silero VAD), voices evened out so nobody is too loud or too quiet, optional clean-up of other people's noisy mics, and audio that rides out lost packets. Admins can allow **hi-fi** (stereo, 128 kbps, unprocessed) in a channel for music and instruments.
- **Camera and captions, on your device:** blur your background or replace it with a picture or a colour, and turn on **live captions** in calls (English and Swedish). It all runs on your own device: no sound, picture or text is sent anywhere. The captions model comes from your own server, which fetches it once.
- **Stages and watch parties:** listen-only rooms where moderators bring people up to speak, and video links, uploads or YouTube watched in step by everyone in voice.
- **Friends, DMs, group chats and calls:** friend requests like on Discord (right-click anyone; requests are end-to-end encrypted and signed, so servers never see your friends list). DMs (with pictures, files and voice messages), group chats of up to ten and voice and video calls, one-to-one or in a group, are all end-to-end encrypted, and DMs have forward secrecy. Compare safety numbers to be sure who you're talking to.
- **Encrypted private channels:** admins can make a small private text or voice channel (up to 50 people) end-to-end encrypted. Only the people who can see it can read it, not the server.
- **Status and activity:** online, idle, do not disturb or invisible, a custom status, and "Playing X" from the desktop app if you turn it on.
- **Organized your way:** channel categories, server folders, notification levels and mutes per channel or server, nicknames, unread navigation and keyboard shortcuts.
- **Profiles your way:** avatar, bio, pronouns and an accent colour, plus your own profile page in HTML, safely sandboxed. Eleven themes, or write your own in JSON.
- **Bots and webhooks:** Discord-compatible webhooks (GitHub too) and a small Node SDK for bots.
- **Roles and moderation:** custom roles with permissions, colours and per-channel overrides, private and read-only channels, invite links with expiry or single use, blocking, timeouts, slowmode, server mute, kick, ban and an audit log. AutoMod blocks words, spam, mention spam and invite links, server rules greet new members, and anyone can report a message or a person to the moderators' queue.
- **Your account is a key on your devices,** stored encrypted, with an optional app lock you can open with a passkey (fingerprint, face or security key). Link a phone by scanning a QR code, see your devices, remove any of them, and replace your account key if it ever leaks. **Key transparency** lets your app notice if a server shows different people different keys.
- **Easy hosting:** a setup wizard with starter templates, "Keep my server running", and one switch that opens the ports on your router, gets a free address and sets up HTTPS. Iskra tells you what it found out about your connection, walks you through port forwarding (with a ready-made prompt for an AI assistant, if you'd like help), explains carrier-grade NAT plainly with your options, and can set up a rented server for you. Your server, your choice: Iskra gets nothing from any of it.
- **Your server is a folder,** with daily backups. Download an encrypted backup, restore it anywhere and move your members along, or import your Discord server's history. Standalone servers can update themselves (checked against the published checksums, with automatic rollback) and answer `/health` for uptime monitors.
- **Your data, your call:** **Download my data** gets you everything a server keeps about you, the owner chooses how long things are kept, a security log shows the owner sign-ins and key changes (never messages), and you can delete your account on every server at once.
- **Everywhere:** apps for Windows, macOS, Linux and Android, auto-update, a tray and iskra:// invite links, and a web app for PCs and phones that installs like an app (on iPhone too). The web app sends push notifications through your browser; the phone apps show notifications while they're open.
- **In English and Swedish,** following your system language or your pick in Settings.

How privacy works, and what a server can and can't see: [docs/security.md](docs/security.md). What runs on your device for voice, video and captions: [docs/voice-processing.md](docs/voice-processing.md).

## Coming next

- **An iPhone app in the App Store.** Until then, the web app installs to your Home Screen.
- **DMs with people you share no server with.**

## For developers

- [Development guide](docs/development.md): layout, running locally, tests, builds.
- [Protocol](protocol/PROTOCOL.md): everything the server and clients say to each other.
- [Bots and webhooks](docs/bots.md).
- Built with C# / .NET 10, TypeScript / React, Electron, Capacitor, LiveKit and libsodium.

## License

Source available, free for non-commercial use: [PolyForm Noncommercial 1.0.0](LICENSE). Use it, host it and change it for any noncommercial purpose.

Like it? [Buy me a coffee on Ko-fi](https://ko-fi.com/vlundgren) or [donate with PayPal](https://paypal.me/iskrafoo).
