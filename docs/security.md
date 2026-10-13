# How Iskra keeps you safe

Iskra is built so that **nobody has to trust a company**, and so you only have to trust the people you actually rely on.

## Your account is a key

There's no email and no password. On first launch the app creates a key pair on your device; the public half *is* your account. Each device gets its own key, certified by your account key.

- Joining a server means signing a fresh challenge from that server. Nobody can join as you without your device, and a login meant for one server can't be replayed against another.
- Names aren't unique, keys are. If you want to be sure who someone is, compare **safety numbers** (open a DM, click *Verify*).
- Your **recovery key** (Settings → Recovery key) restores your account on a new device. It's the only copy outside your devices, so keep it somewhere safe, like a password manager. Anyone who has it can use your account, until you replace your account key (below).

## Replacing your account key

If your recovery key leaked, or someone may have copied one of your devices, **replace your account key** (Settings → Recovery key → Replace account key).

- Your device makes a new key and your old key signs it over, and the new key signs too, so nobody can point your account at a key they don't hold. Your servers check both signatures, then move your membership, role, profile, messages, reactions and direct messages to the new key, and keep a record of the change.
- You choose which of your devices to keep. Each one gets a new certificate and the new key, sealed to that device (libsodium `crypto_box_seal`); it only accepts a key that matches the signed hand-over, so a server can't slip in one of its own. Devices you untick are signed out for good.
- Your old key and old recovery key stop working on every server that has the change. You get a new recovery key straight away. Servers you weren't connected to get the change the next time you connect.
- Your friends' apps check the signatures themselves, keep your conversation and its history, and show **"safety number changed"**, so they can verify you again.

**What if someone else has your old key?** They could try to replace it too, and a server can't tell which of you is the real one. Iskra's rule:

1. The first valid replacement wins on each server.
2. Every device of the old account is told. A device that wasn't given the new key says "Your account key was replaced" and offers **That wasn't me**: it claims the account for a new key of yours.
3. A second, different claim within 30 days doesn't win, but marks the account as **disputed**: its role drops to member (so a thief can't keep admin or owner rights) and admins are asked to decide. An admin who knows you keeps the right key, which restores your role. After 30 days the old key is simply dead.

So act fast: on servers where you replace the key first, you win outright. On a server where a thief got there first and nobody else is an admin, the account stays disputed. Your friends' apps warn them while an account is disputed.

## Your devices

- **Linking a device** (Settings → Devices → Link a device) moves your account to a phone or another computer without typing the recovery key: scan the QR code or type the code. The code holds a one-time secret that never reaches the server; both devices prove they know it, then the new device shows a six-digit number that you type into the signed-in one before anything is sent (a wrong number cancels the link). Your account is encrypted from one device straight to the other (libsodium `crypto_box`), so the server that relays it can't read it or slip in a device of its own. Codes expire after five minutes and work once.
- **Removing a device** (Settings → Devices) signs a revocation with your account key and hands it to every server you're on. Servers then refuse that device, sign it out, stop listing it and stop sending it push notifications, and senders stop encrypting messages for it.
- Every linked device keeps your account key in the app's storage (that's what lets it link and remove devices too). **Removing a device stops that device's own key**: it can't connect or get new messages. It does **not** stop someone who copied the device's storage: with the account key they can certify a new device as you. For a copied device, [replace your account key](#replacing-your-account-key) and leave that device out. Servers let one connection remove at most 10 devices an hour, so a thief can't use up the account's 100 removals at once.

## Your keys on your device

Your keys, your devices' short-lived DM keys and your decrypted direct messages are stored **encrypted** (XChaCha20-Poly1305), with a key that is itself protected by:

- **the desktop app:** your operating system's keychain (Windows DPAPI, macOS Keychain, or GNOME Keyring / KWallet on Linux). A copy of Iskra's data folder is useless on another computer or user account. On Linux without a keyring, the app says so and uses the browser method below.
- **the browser:** a key the browser keeps for Iskra and never reveals to the page (a non-extractable WebCrypto key). That keeps your keys out of copies, exports and casual snooping of the stored data. It does *not* stop someone who can use your browser profile or run code in the app.
- **an app lock (optional, My settings → App lock):** a passphrase, stretched with Argon2id, that Iskra asks for at every start. Without it, nobody can read your keys or messages from the device's storage, even with a full copy. Forget it and you'll need your recovery key.
- **passkeys (optional, My settings → App lock):** unlock with your fingerprint, face, device PIN or a security key (Windows Hello, Touch ID and Face ID, Android, iCloud Keychain, Google Password Manager, security keys). This isn't just a screen in front of the app: Iskra asks the passkey for its PRF secret (the WebAuthn PRF extension, which only that passkey can produce, after it has checked it's you) and derives the key that unlocks your data from it (HKDF). Without the passkey or your passphrase, the stored keys stay encrypted. Passkeys that can't do PRF are refused with an explanation, and the passphrase is always there instead. You can add several (a laptop's Windows Hello and a security key, say), rename and remove them; your recovery key works as before.

Data stored before this existed is encrypted the first time the app starts. Linking devices and recovery keys work as before.

### Where passkeys work

| Where | Passkeys for the app lock |
|---|---|
| Chrome, Edge (Windows, macOS, Linux, ChromeOS) | Yes, with passkeys that support PRF: Google Password Manager, security keys with `hmac-secret`, phones (scan a QR code), and Windows Hello or iCloud Keychain where the system offers PRF |
| Safari 18 and later (macOS, iPhone, iPad) | Yes, with iCloud Keychain passkeys and security keys |
| Firefox | Recent versions, with security keys and passkeys that support PRF |
| Android (Chrome, and the Iskra app, which runs in Chrome) | Yes, with Google Password Manager passkeys and security keys |
| Desktop app on Windows | Yes: Windows Hello, security keys and phones. The app's own page can't use WebAuthn, so it opens a small window on `app.iskra.foo` for the passkey prompt |
| Desktop app on macOS and Linux | Security keys. Touch ID and iCloud Keychain are only offered to browsers, so on a Mac use a security key, a passphrase, or Iskra in Safari |
| iPhone app | Prepared (`webcredentials:app.iskra.foo`), not yet confirmed on devices; if iOS refuses, the app says so and you use a passphrase |

## Key transparency

A server can't forge anyone's signature, but it does decide which key it shows you as "Alice". Key transparency makes it hard for a server to show different people different keys, or to rewrite what it showed, without being caught.

- **Each server keeps a key log**: every account key it has shown (with a salted hash of the name it showed; the name itself is kept beside it and erased when the account is deleted), every key replacement and every dispute, in order. Each entry is linked to the one before it by a hash, and the server signs the newest one with its own key. Entries are only ever added.
- **Your app checks it every time it connects**: the log must carry on from the point your app saw last (never shorter, never different), every member the server shows must be in it, and every key replacement it announces too.
- **Your servers are compared with each other**: if two servers say someone's old key moved to different new keys, you're told.
- **Your friends' apps compare notes with yours**: now and then a DM carries a small signed summary (inside the end-to-end encryption) of the logs you both see and the key replacements you know. If a server signed one log for you and a different one for your friend, the two signatures prove it, and both apps say so. It also shows when a server lists a device for a friend that their own app doesn't know.
- **Someone using a friend's name** with a different key, on a server your friend isn't on, gets a gentle warning.
- You see what was found in My settings → Recovery key, above the chat when it's serious, and in the DM with the person concerned. Anyone can read a server's whole log in the app (My settings → Recovery key → View log), checked from the first entry: the view an owner or auditor uses. Problems an app finds are also reported to the server's owner, in its security log, and so is a log that was changed in the database.

**What it catches:** a server that shows you a key its own log doesn't have; a server that shows two people different histories (a "split view"), as soon as two people who use that server talk to each other by DM; a server that rewrites or rolls back its log; servers that disagree about where someone's account went.

**What it doesn't:** it detects, it doesn't prevent. A server that shows *everyone* the same fake person is consistent: names aren't identities, so if the first time you ever meet someone is on a server you don't trust, nothing but comparing safety numbers tells you it's really them. A split view stays hidden from someone who shares no friend with the people they're checking and never compares safety numbers. A server can refuse to answer (the app then shows it as unchecked, not as fine). The log tells members which keys joined when, under which names, which they could see in the member list anyway. Restoring a server from an older backup rolls its log back too, so members' apps will flag it: tell your members when you do.

**Compared to the big systems:**

| | Iskra | CONIKS | Keybase | WhatsApp key transparency |
|---|---|---|---|---|
| Directory | One small log per server, read in full by every member's app | A Merkle prefix tree per provider, one signed root per epoch | Per-user signature chains plus one global Merkle tree | An auditable key directory (append-only Merkle tree), one published root per epoch |
| Catching a split view | Signed heads gossiped between friends inside E2EE DMs, plus comparing servers | Clients and auditors gossip signed roots | The root was anchored in a public blockchain | A third-party auditor checks that each root only extends the last one |
| Checking your own key | Your app sees the whole log and every replacement of your key | Clients check their own entry every epoch | You sign your own chain | Your app checks your own entry |
| Privacy of the directory | Members see the log (as they see the member list) | Hidden names (VRFs) | Public | Hidden (VRFs) |
| Who could still fool you | A server you only use with people you never DM, on first contact | A provider nobody gossips with | The service, until someone checks the anchored root | The provider and the auditor together |

Iskra's version is deliberately light: servers are small and many, so a full log costs little, and there's no company to run auditors. It adds most where several servers or friends overlap.

## Who can read what

| What | Protected by | Who can read it |
|---|---|---|
| Everything on the wire | HTTPS / WSS (when the server has HTTPS) | You and the server |
| Server channels, voice channels, files, profiles | The server's permissions | Members allowed in that channel, and whoever runs the server |
| Direct messages, with their pictures, files and voice messages | **End-to-end encryption** | Only the two of you |
| Group chats, with their files | **End-to-end encryption** | Only the people in the group |
| **Encrypted channels** (an option for small private text and voice channels), with their files, threads and voice | **End-to-end encryption** | Only the people who can see the channel, on their own devices |
| Calls in DMs and group calls (voice and video) | **End-to-end encryption** | Only the people in the call |

Server channels trust the server, because a server is run by you or your friend; the app always tells you which server you're on. Direct messages, group chats, calls and encrypted channels don't trust anyone: servers only pass encrypted envelopes and encrypted media along.

### Direct messages in detail

- Encrypted with XChaCha20-Poly1305; the key is wrapped for each of the recipient's devices and your own.
- **Forward secrecy.** Each device has a short-lived encryption key (a *prekey*), signed by the device, replaced every week and deleted 30 days after that. Each message's key is sealed to the recipient devices' current prekeys with a fresh one-time key (libsodium `crypto_box_seal`, around a `crypto_box` from the sender's device that proves who sent it). Once a prekey is deleted, messages sealed to it can't be decrypted again, even by someone who later steals your devices' long-term keys and every encrypted message a server ever stored. Your app keeps the messages it has already decrypted on the device, so your history stays readable.
- Why not a ratchet like Signal's: a conversation here travels over whichever server you share, across several devices each, which are often offline for days. Weekly prekeys give forward secrecy without per-device session state that can get out of step. There's no "healing" after a break-in, though: a stolen device can read new messages until you remove it.
- The sender, recipient, time and message id are bound into the encryption, so a message can't be altered, replayed or moved to another conversation.
- Device keys come with certificates signed by the account, so a server can't slip in a device of its own.
- There's no unencrypted fallback: if a message can't be encrypted, it isn't sent.

### Pictures, files and voice messages in DMs and group chats

- Each file is encrypted on your device with its own random key (libsodium `crypto_secretstream`, in 64 KB chunks, so a changed, reordered or cut-off file is caught). The key, the name and the type travel inside the encrypted message; the server only stores ciphertext.
- Files can be as big as the server allows for any upload (512 MB by default). Your app encrypts a big file a piece at a time while it uploads it, and decrypts it a piece at a time while it downloads, so it never holds the whole file in memory. In the desktop app and in Chrome or Edge, saving writes straight to disk; the file only appears under its name once every chunk, the end marker and the hash of the whole file have checked out, and a file that fails any check is deleted. Other browsers and phones decrypt into memory first, with the same checks before you can save it.
- The server hands a file only to the people in the conversation (for a group: its members when the file was shared), through short-lived signed links, and never shows it as a web page or image.
- Your app decides how to show a file from its **decrypted bytes**, with the same rules as channel uploads: only real pictures, video and audio play inline; anything else is a download.
- The server sees how many files you send, when, to whom and roughly how big they are; not what's in them, their names or whether one is a voice message.

### Group chats in detail

- Group messages are encrypted like DMs, with forward secrecy, for every device of every member.
- **Who is in a group is a chain of signed changes**: every add, removal or leave is signed by the member who made it and linked to the change before it. Your app checks every link itself, so a server can't add anyone to a group, reorder its history or slip in a member list of its own. Someone who replaced their account key stays the same member.
- A message names the exact member list it was encrypted for, so it can't be passed off as sent to different people. New members only read what's sent after they joined.
- Group calls work like DM calls: a fresh key per call sent inside the encrypted group chat, and a new one when the group changes during the call.
- The server knows who is in which group and when people write; it doesn't know the group's name or anything said in it. Notifications only say "New message from X".

### Encrypted channels in detail

When an admin creates a text or voice channel they can tick **End-to-end encrypted**. It's meant for small private channels (up to 50 people) and can't be turned off later. A lock marks it everywhere.

- **Who's in it follows the channel's permissions**, but the permissions don't decide alone. Membership is a chain of signed changes, like a group chat's: every add, removal or new key is signed by the member who made it and linked to the one before. When roles or channel settings change, the server says who should be added or removed, and the first member whose app is online signs that change. Your app checks every link itself, so **the server can't add anyone on its own**: it needs a member's signature (members' apps sign the adds the channel's permissions call for, see Limitations below), and while you're still in a channel's chain your app never accepts a different chain in its place (unless you choose to start over, see below). The server also refuses changes that don't match the permissions, and only ever delivers the channel's (encrypted) messages to people who can read it right now.
- **Every change brings a new key.** Each change starts a new *epoch* with a fresh random key, made on the device of the member who signed the change and sealed to every device of every member (the same forward-secret envelopes as DMs). Someone who loses access never gets the next key: what's written after they're removed is unreadable to them even if they kept a copy of everything the server stores. Keys of different epochs are unrelated, so an old key says nothing about a new one.
- **Messages** are encrypted with the epoch's key (XChaCha20-Poly1305) and **signed by the sender's device**, because everyone in the channel shares the key: without the signature one member could write as another. The channel, the thread, the exact member list and the sender are bound into each message (and into each edit, the message it edits), so the server can't move a message into another channel or thread, or pass an edit off as a different message. Your app remembers which versions of a message it has shown, so a replayed message or an older version after an edit is refused on that device. A message that claims to come from someone more than 10 minutes after they lost access is shown with a warning and never notifies. Messages sent by apps from before this protection show as "Older format".
- **New members** read from when they were added. Older messages stay unreadable to them, as in Signal; there's no way (yet) for an admin to share older history.
- **Your devices:** a device linked later gets the key automatically (it asks for a new one if nobody included it), and when you remove a device, one of your other devices hands out a new key in each encrypted channel you're in.
- **Files, voice notes and threads** are encrypted the same way. **Voice** in an encrypted voice channel uses LiveKit's end-to-end encryption with a key derived from the channel's current key, and switches when it changes.
- **Safety:** the encryption panel (the lock in the channel's header) lists exactly who holds the key, with each person's safety number and any key-transparency warnings about them.
- **Starting over:** if everyone in a channel's chain loses access (they all lose the permission to see it, or leave), nobody is left to add the people who can see it, so the first of them whose app is online starts a new chain. Its messages are new; the old ones stay readable only on devices that already had their keys. Someone who was in the old chain and gets access back is the hard case: from inside the chain, a new one looks exactly like a server trying to hand the channel to an account it controls, so **their app never switches by itself**. It keeps the chain it checked, turns sending off, and says *"The people in this channel started its encryption over. Check their safety numbers before trusting new messages."* The encryption panel then shows who signed the new chain (who started it, who added you, who handed out keys; each change signs the whole chain before it) and how well you know each key: **same key as before** (they were in the old chain with you), **someone you know** (a friend or someone you've messaged), or **new to you**. Starting over is a button, never automatic. If none of the signers is a key you knew, or a new key carries the name of someone from your old chain, you must tick that you compared safety numbers first; a serious key-transparency warning about a signer, or a chain that doesn't list you yet, blocks it. Afterwards the old chain and its keys stay on your device for old messages, your app signs a new key in the new chain (so the others see you joined, and anyone starting over later sees a key they knew), the channel shows "You started encryption over on …", and a chain you left is never accepted again.
- **What doesn't work there**, because the server would have to read or write the text: webhooks (incoming and outgoing), bots reading or posting in the channel, built-in bots, polls, scheduled messages, forwarding, clips, stickers, GIFs, AutoMod and link previews. Commands for bots that take interactions still work, privately: the app warns first that the command goes to the bot unencrypted, and only you see the answer (see Limitations). Search runs on your device, over the messages it has decrypted. Notifications only say "New message in #channel". A report can include what the message says, but only if the reporter shares it, and moderators are told the server can't check it.

**What the server still sees** in an encrypted channel: who is in it and when that changes; who writes, when, how often and how big each message is; who replied to which message, reactions (which emoji on which message), pins, deletions and edits (that one happened, not what changed); thread structure (threads have no name); who joins its voice channel and when; the channel's name and settings. It can delay or withhold messages and membership changes, but not read, forge or reorder them.

### Calls in detail

- The caller's app makes a fresh random key for each call and sends it inside a normal end-to-end encrypted DM (with forward secrecy), so the server never has it.
- Both apps hand that key to LiveKit's end-to-end encryption: every audio and video frame is encrypted with AES-GCM before it leaves your device. The voice server only forwards ciphertext.
- A browser that can't encrypt media can't join the call. There's no unencrypted fallback.
- The server decides who may join a call's room: only the two people in the call get a ticket for it, and anyone else who shows up is removed.

## What servers do to protect members

- Identity comes only from the signed handshake; every request and every broadcast is checked against your role *at that moment*.
- Private channels never leak, not even their existence. Search only looks in channels you can read right now.
- Uploads are checked by content, never by name. Only real images, video and audio display inline; everything else is a download, served with headers that stop it from running as part of the site.
- Link previews are fetched by the server so your IP isn't sent to every site, and the fetcher refuses private and internal addresses (also through redirects).
- Rate limits, size limits and strict input validation on everything. Uploads, calls and new threads are limited per account, and each account has a daily upload allowance.
- On Linux and macOS, the server's keys and other secrets are readable only by the user that runs it.
- Who's in a voice channel or call comes only from the voice service's signed reports, never from what a client claims.
- **Roles:** custom roles only add the permissions given to them; someone who manages roles can only change roles below their own highest one and can't hand out permissions they don't have. Channel overrides are checked on the server for every message, upload, voice join and broadcast. Only people with the right permission can mention a role that isn't open to mentions.
- **Stages:** who may speak is enforced by the voice service itself. Everyone joins a stage listen-only, and the server tells the voice service to allow (or stop) someone's microphone, camera and screen share when a moderator brings them up (or back down). If it can't, it fails closed.
- **Blocking someone** stops DMs and calls between you on every server you share (the list goes with you, but never to anyone else), ends a call with them, and stops their messages, mentions and group call rings from notifying you. Their messages in shared channels and groups are still there, collapsed in your app.
- **Timeouts and slowmode** are enforced by the server: a timed-out member can't write, react, use voice or make posts and events until it ends. Moderation actions are written to an audit log admins can read; message text and invite codes never are.
- **Backups** are encrypted with a passphrase you choose (Argon2id, then XChaCha20-Poly1305 in chunks, so a changed or cut-off file is caught). The passphrase is sealed to the server's key before it leaves your app, so it never crosses the network in the clear, even without HTTPS. The automatic daily backups in the server folder aren't encrypted: they sit next to the keys already, so keep that folder private.
- **Discord imports** only read the uploaded export: files referenced inside it are matched by name inside the archive, never fetched from Discord or read from anywhere else on disk.

### Security log, retention and your data

- **Security log** (Server settings → Sign-ins & security, the owner only): failed sign-ins, rate-limit hits, new members and devices, account key changes, account deletions, removed devices, backups and restores, moves, retention changes and data downloads, with the account key and time. Never message text, invite codes, passphrases or keys. IP addresses only if the owner turns that on (off by default). Bursts of the same event are capped, so a flood can't fill the disk. Moderators' actions stay in the audit log.
- **Retention:** the owner chooses how long the server keeps messages (and encrypted DM and group envelopes), files in messages and DMs, the audit log (90 days by default) and the security log (365 days). 0 keeps forever; older data is deleted every hour.
- **Download my data** (Settings → Privacy & data): a zip of everything a server keeps about you, through a link that works for 10 minutes; the owner can make one for a member who asks. The content of your DMs and group chats is only on your devices, so **Download data on this device** exports it from there (without your keys).
- **HTTP:** every response refuses MIME sniffing, referrers and framing by other sites; HTTPS uses TLS 1.2 or 1.3 and HSTS for domain names. The voice service's own API only listens on the server itself.

### Profile pages

A profile page is HTML someone else wrote, so it's locked in a strict sandbox. It only loads when you click *Open profile page*. The promise: **a page can't make your device contact anyone, so its author can't learn your IP address or anything else about you.** It can use HTML, CSS, JavaScript, canvas and animations, with pictures and sound from `data:` URLs. Everywhere:

- it runs on an empty, throwaway origin: no cookies, no storage, no access to the app, your keys or the server;
- it has no network: it can't fetch anything, load outside images, fonts, styles, audio or video, open pop-ups, submit forms or navigate anywhere;
- it gets no camera, microphone, autoplay or other device access.

How each app keeps that promise:

- **Desktop app: scripts run for everyone.** Pages (and the editor's preview) run in a separate, in-memory browser session used only for pages, inside a view the app checks before it opens. In that session no request reaches the network except the page itself, which the app fetches for it from its server; WebRTC can't use UDP, and everything else, including WebRTC over TCP, goes to a proxy on a closed local port with no direct fallback. The page view has no Node.js or preload, no permissions, no pop-ups, no downloads, and can't navigate.
- **Browsers and the phone apps: other people's pages show without scripts.** Browsers can't fully block WebRTC: a page script can create a child frame with its own script, and that frame's WebRTC can reach any address. With scripts off, plain HTML and CSS can't reach anything (we test 41 ways, from images and fonts to preconnect hints and speculation rules). The app says interactive pages run in the desktop app. Your own page and the editor's preview keep their scripts, since they're your own code.

We test this: the tests point a page at a fake attacker on the same machine with 70 different ways to reach it, check that a page without the wall *does* reach it, and require zero connections from a page in each app. Admins can turn pages off for their server or remove a member's page.

### GIFs

The GIF picker uses KLIPY. An admin adds a KLIPY key and chooses how members' apps reach it:

- **Through the server** (the default): the server searches and fetches the GIFs, so your device never contacts KLIPY and KLIPY only sees the server. It only fetches from KLIPY's image hosts, only addresses it signed itself, and never stores the files.
- **Straight from KLIPY** (only if the owner picks it): your app searches KLIPY itself, so **KLIPY sees your IP address and what you search for**, under a per-member pseudonym rather than your account key. GIFs in messages don't load until you click them (you can turn on auto-load for your device), and they're shown in a sandboxed frame that can only load images from KLIPY's own image hosts.

Ads stay off, and anything that isn't a GIF from KLIPY's own hosts is left out.

### Watch parties

A watch party only shares a clock: each app plays the video itself, from its source. **Whoever hosts the video sees your IP address**: YouTube for a YouTube video, the website for a link, your server for an upload. Before anything loads from YouTube or a website, the app says where it plays from and waits for you to press Watch (unless you ticked "Always load from <site>" on that device). YouTube plays in its privacy-enhanced (youtube-nocookie.com) player inside a sandboxed frame; no YouTube code runs inside the app itself, where it could reach your keys. The desktop app sends YouTube the web app's address as the referring page (YouTube requires one) and nothing else.

### Activity status

"Playing X" is off until you turn it on in the desktop app. Games are recognised on your own computer by matching running program names against a list; only the game's name is sent, never the list of programs. It's kept in memory while you're online and hidden while you appear offline or invisible.

### Themes

A theme is a JSON file of colours, sizes and font choices. Every value is checked against a strict pattern and applied one setting at a time, so a theme can't inject CSS or code.

### Push notifications

- Notifications go from your server through your browser's push service (Google, Apple, Mozilla or Microsoft), encrypted so that service can't read them.
- **DM notifications never contain the message**, just "New message from X". Mentions and replies carry a short excerpt from the channel.
- Each server has its own push key, and a subscription belongs to one device. Your server only accepts addresses at known push services and doesn't notify a device you're actively using.
- The phone apps don't use push at all: they show notifications while the app is open, straight from your servers. No Iskra-run service sits between your server and your phone.

### Voice, video and captions on your device

AI noise removal, voice detection, evening out voices, cleaning up others' audio, camera background blur and replace, and live captions all run **on your own device**: no sound, picture or caption text is sent anywhere for processing, and captions are never stored or sent to the server. The models ship with the app, except the captions model, which the app downloads once from the server of the call you're in (the server fetched it once from Hugging Face; only members get a link to it). Both the server and the app check every part against SHA-256 hashes built into Iskra before using it, and the workers that run the models can't fetch anything. Details, models and licenses: [voice-processing.md](voice-processing.md).

**Clips** are recorded on the device of the person who saves one, from what their app already plays. Turning clips on is shown to everyone in the call and saving one posts a notice, but that's a courtesy between honest apps: nothing can stop a modified app from recording what it receives, in any call.

### Hosting help and rented servers

- **What Iskra found out** about your connection comes from your own router's answers and your computer; no outside service is asked. The prompt for an AI assistant holds your local network details and the ports, never your public address, keys or invite links, and you see and can edit it before copying.
- **Rent a small server:** the app makes a one-time owner key and puts it in the setup text. The new server keeps it in a file only it can read and never logs it. Before trusting the server, the app asks it to prove it holds the key (HMAC over a fresh nonce), so a different machine at that address can't pose as yours; then it joins as owner and the key is deleted. Until then the app keeps the key in its encrypted store. The setup text downloads the server from GitHub and checks it against the published `SHA256SUMS.txt` before installing, and opens only the ports Iskra needs. Your provider can see what's on a server you rent from them.
- **Keep my server running / `install-autostart`** runs the server as you, never with administrator rights.

### Server updates

A standalone server can check GitHub for new versions and, on Linux with systemd, install them itself (the owner picks: off, tell me, or install automatically). A package is only used if its SHA-256 matches both `SHA256SUMS.txt` and the checksum GitHub lists for the file, its build-provenance attestation verifies on the server (Sigstore, signed by Iskra's release workflow on GitHub's runners for that file; on by default, the owner can turn it off with a warning), the archive holds nothing but plain files, and the new version starts on that machine. If it doesn't start, the previous version is put back. Every check, install, failure and rollback goes into the security log. `/health` reports only the version, uptime and whether voice is up: no names, addresses or member counts.

### Webhooks and bots

- A webhook URL contains a long random secret. The server only stores a hash of it and shows the URL once; an admin can replace it at any time. Treat it like a password, and use the `https://` address (a server without HTTPS can only take it in plain text): a server with HTTPS refuses webhooks sent to its plain `http://` address from other machines (with "use https"), rather than quietly forwarding them.
- Webhook posts can't ping anyone unless an admin allows it for that webhook, and images from the payload are dropped, so a webhook message can't make viewers' apps contact a third-party address.
- Bots are marked with a **BOT** badge, can only join with a single-use bot invite from an admin, can't join voice, make or take calls, send DMs or create invites, and can't be made admin.
- **What a bot reads is the admin's choice.** By default a bot gets only its commands, button clicks and forms, messages that mention it or reply to it, and its own messages; requests that read the rest (history, search, pins, threads, forums, docs) are refused. An admin can let a bot read all messages, when inviting it or later, and everyone can see which bots can. Bots that joined before this choice existed keep reading everything until an admin changes it.
- **Commands, buttons and forms** go to the bot through the server, which checks every one against what the bot declared and who may use it. Each interaction has a random token that works only for that bot, for 15 minutes. Answers marked private go only to the person who asked and are never stored.
- **Built-in bots** (Dice, Polls, Reminders) run inside the server: no outside program, no network connection. Their keys are made fresh and the private half is thrown away, so nobody can sign in as them. They read nothing but their own commands and never answer in encrypted channels.
- **Outgoing webhooks** send chosen events (messages and reactions in chosen channels, people joining or leaving, events starting) to an `https://` address an admin picks, never anything from encrypted channels, DMs or group chats. Each request is signed with a secret for that webhook (HMAC-SHA-256 over the time, a delivery id and the body), so the receiver can check it came from your server. The server checks the address after every DNS lookup and never connects to private, loopback, link-local or cloud-metadata addresses, and never follows redirects; only the owner can allow addresses on the server's own network. A webhook that keeps failing turns itself off. Every member can see which sites their server sends to (**My settings → Privacy & data → Who Iskra talks to**).

## Limitations

We'd rather tell you than have you find out:

- **Server channels, voice channels and files are not end-to-end encrypted,** unless the channel was made an encrypted channel. Whoever runs the server can read them.
- **Encrypted channels:** the people who can see the channel decide who gets the key, so whoever controls the permissions (admins, and whoever runs the server, through the permissions) can add a reader; that reader's app is added by a member's app, signed and visible in the encryption panel, and only reads what is written from then on. A member who is removed keeps what they already read. A device's stored epoch keys let it read the channel's history, so a stolen unlocked device reads it too (as with DMs kept on the device). Membership changes need a member's app online; until then, someone who just lost access can't receive anything (the server stops delivering at once), and someone who just gained it waits. Two members' apps that never compare notes could, in a rare race, see different (correctly signed) membership histories. A chain that was started over is only as trustworthy as the keys that signed it: Iskra shows who they are and asks you to compare safety numbers when you didn't know any of them, but it can't tell a friend who really restarted the channel from a server account using their name if you skip that check. We don't require the new chain to be signed by someone from the old one: by the server's rule nobody in the old chain could read the channel when it was restarted, so a legitimate restart is usually started by someone new, and a forger would simply leave the old members out.
- **Metadata.** Servers see who messages and calls whom, when, and for how long. Your push service sees when you get a notification.
- **Replacing a stolen account key is a race.** Whoever holds your old key can replace it too. On each server the first valid replacement wins; a second claim within 30 days makes the account disputed until an admin decides, and after 30 days the old key is dead. A thief who acts first on a server where you don't (or that has no other admin) keeps the account there until an admin steps in. Your friends see "safety number changed" either way: verify before trusting.
- **Keys on your device are only as safe as the device while Iskra is running.** Encryption at rest protects copies of the stored data, not a device someone can use as you. In the browser, without an app lock, anyone who can open your browser profile can open Iskra. Malware running as you can read keys from memory. Lock your devices, and use an app lock on shared computers.
- **Forward secrecy has limits:** it covers messages once their prekey is deleted (at most about five weeks after sending). A device that hasn't published a prekey (an older app version) gets messages wrapped to its long-term key instead: still end-to-end encrypted, without forward secrecy, and a server could hold back prekeys to force that.
- **Safety numbers are opt-in.** Until you compare them, you trust that the server showed you the right person the first time. [Key transparency](#key-transparency) catches a server that shows different people different keys, but not a fake person everyone is shown.
- **Calls use one key for the whole call**; in a group call the key changes only when the group does, so someone who leaves the call but stays in the group could still decrypt it (they could rejoin anyway).
- **Group chats:** the server can't add people or read messages, but it can hold back a change for a while, and two devices that never compare notes could, in a rare race, be shown different (correctly signed) versions of a group's history. There's no group-wide safety number: compare each person's.
- **Watch parties, link embeds and GIFs** load from their sources (YouTube, a website, KLIPY), which then see your IP address: only after you click (watch parties and embeds), or for GIFs only if the owner picked "Straight from KLIPY" (the default goes through the server). The full list is in [privacy-connections.md](privacy-connections.md).
- **Bot commands in encrypted channels** go to the server and the bot unencrypted: the command and its options (whatever you type after `/name`) are not end-to-end encrypted, though the channel's messages and keys never reach the bot. The app says so before you send, and the bot's answer is shown only to you.
- **Tying encrypted messages to their place has limits.** A replayed message, or an older version after an edit, is caught only on devices that already saw the newer one. Messages written before this protection (shown as "Older format") can still be moved by a server between a channel and its threads. And a removed member working together with the server can still backdate a message into the time they were a member, because both clocks would then lie in step; neither can make it look sent after the removal, or move it to another channel or thread.
- **Outgoing webhook secrets are kept on the server** (it needs them to sign), so they're in the database, its daily backups and downloaded backups (encrypted with your passphrase). Anyone with a copy of the server's folder can sign requests as that webhook: regenerate the secret if a copy leaks. Incoming webhooks keep only a hash of their secret.
- **Profile pages:** in browsers and the phone apps, other people's pages show without scripts (see [Profile pages](#profile-pages)); only the desktop app runs them. If you paste someone else's HTML into your own page, its scripts run in your browser's preview, where a script can reach the network through WebRTC. A page may show images uploaded to its own server, and that server can see when they're loaded. Browser and WebView engines we can't test (WebKit on iPhones) are covered by the same rules but not by our tests.

## The desktop app

The desktop app is the same web app in a locked-down shell: sandboxed, no Node.js in the page, links open in your browser, and the page can only ask the app for push-to-talk, the screen picker, call alerts, updates, opening the system's privacy settings, hosting and restoring backups, its own settings, the taskbar badge, the keychain that protects your keys, passkey prompts for the app lock (in a separate window that can only show Iskra's own prompt page), profile page views (in their own walled session, see [Profile pages](#profile-pages)), and the game you're playing (when you turned that on).

- `iskra://` links only ever open an invite: anything else in them is ignored.

- **Windows:** every executable we ship is code-signed (Open Source Developer Viktor Lundgren, issued by Certum) and timestamped, so you can check it came from us and wasn't changed. The installer only installs updates signed with that same certificate.
- **macOS and Linux:** the macOS app is signed with a Developer ID and notarized by Apple; the Linux packages aren't signed. Every release has `SHA256SUMS.txt` and build-provenance attestations (`gh attestation verify <file> -R quikmn/iskra-voice`). Download only from the GitHub releases page.
- Servers you create in the app run on your computer and only open ports to the internet when you switch on **Let friends anywhere join**.

## Found a problem?

How this maps to SOC 2, ISO/IEC 27001, the GDPR and OWASP ASVS, with the policies and evidence: [docs/compliance](compliance/README.md).

For a security problem, please [report it privately](https://github.com/quikmn/iskra-voice/security/advisories/new) or email spark@iskra.foo, not in a public issue. [SECURITY.md](../SECURITY.md) explains what's in scope and what to expect. For anything else, open an issue on [GitHub](https://github.com/quikmn/iskra-voice/issues).
