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
- **an app lock (optional, Settings → App lock):** a passphrase, stretched with Argon2id, that Iskra asks for at every start. Without it, nobody can read your keys or messages from the device's storage, even with a full copy. Forget it and you'll need your recovery key.

Data stored before this existed is encrypted the first time the app starts. Linking devices and recovery keys work as before.

## Who can read what

| What | Protected by | Who can read it |
|---|---|---|
| Everything on the wire | HTTPS / WSS (when the server has HTTPS) | You and the server |
| Server channels, voice channels, files, profiles | The server's permissions | Members allowed in that channel, and whoever runs the server |
| Direct messages | **End-to-end encryption** | Only the two of you |
| Calls in DMs (voice and video) | **End-to-end encryption** | Only the two of you |

Server channels trust the server, because a server is run by you or your friend; the app always tells you which server you're on. Direct messages and calls don't trust anyone: servers only pass encrypted envelopes and encrypted media along.

### Direct messages in detail

- Encrypted with XChaCha20-Poly1305; the key is wrapped for each of the recipient's devices and your own.
- **Forward secrecy.** Each device has a short-lived encryption key (a *prekey*), signed by the device, replaced every week and deleted 30 days after that. Each message's key is sealed to the recipient devices' current prekeys with a fresh one-time key (libsodium `crypto_box_seal`, around a `crypto_box` from the sender's device that proves who sent it). Once a prekey is deleted, messages sealed to it can't be decrypted again, even by someone who later steals your devices' long-term keys and every encrypted message a server ever stored. Your app keeps the messages it has already decrypted on the device, so your history stays readable.
- Why not a ratchet like Signal's: a conversation here travels over whichever server you share, across several devices each, which are often offline for days. Weekly prekeys give forward secrecy without per-device session state that can get out of step. There's no "healing" after a break-in, though: a stolen device can read new messages until you remove it.
- The sender, recipient, time and message id are bound into the encryption, so a message can't be altered, replayed or moved to another conversation.
- Device keys come with certificates signed by the account, so a server can't slip in a device of its own.
- There's no unencrypted fallback: if a message can't be encrypted, it isn't sent.

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

### Profile pages

A profile page is HTML someone else wrote, so it's locked in a strict sandbox. It only loads when you click *Open profile page*, and then:

- **its scripts are off**: you see plain HTML and CSS. You can choose to run a page's scripts (the app warns that the author could then learn your IP address), and that choice is remembered for that version of the page;
- it runs on an empty, throwaway origin: no cookies, no storage, no access to the app, your keys or the server;
- it has no network: it can't fetch anything, load outside images, fonts, audio or video, open pop-ups, submit forms or navigate anywhere;
- it gets no camera, microphone, autoplay or other device access.

Admins can turn pages off for their server or remove a member's page.

### Themes

A theme is a JSON file of colours, sizes and font choices. Every value is checked against a strict pattern and applied one setting at a time, so a theme can't inject CSS or code.

### Push notifications

- Notifications go from your server through your browser's push service (Google, Apple, Mozilla or Microsoft), encrypted so that service can't read them.
- **DM notifications never contain the message**, just "New message from X". Mentions and replies carry a short excerpt from the channel.
- Each server has its own push key, and a subscription belongs to one device. Your server only accepts addresses at known push services and doesn't notify a device you're actively using.

### Webhooks and bots

- A webhook URL contains a long random secret. The server only stores a hash of it and shows the URL once; an admin can replace it at any time. Treat it like a password, and use the `https://` address (a server without HTTPS can only take it in plain text): a server with HTTPS refuses webhooks sent to its plain `http://` address from other machines (with "use https"), rather than quietly forwarding them.
- Webhook posts can't ping anyone unless an admin allows it for that webhook, and images from the payload are dropped, so a webhook message can't make viewers' apps contact a third-party address.
- Bots are marked with a **BOT** badge, can only join with a single-use bot invite from an admin, can't join voice, make or take calls, send DMs or create invites, and can't be made admin.

## Limitations

We'd rather tell you than have you find out:

- **Server channels, voice channels and files are not end-to-end encrypted.** Whoever runs the server can read them.
- **Metadata.** Servers see who messages and calls whom, when, and for how long. Your push service sees when you get a notification.
- **Replacing a stolen account key is a race.** Whoever holds your old key can replace it too. On each server the first valid replacement wins; a second claim within 30 days makes the account disputed until an admin decides, and after 30 days the old key is dead. A thief who acts first on a server where you don't (or that has no other admin) keeps the account there until an admin steps in. Your friends see "safety number changed" either way: verify before trusting.
- **Keys on your device are only as safe as the device while Iskra is running.** Encryption at rest protects copies of the stored data, not a device someone can use as you. In the browser, without an app lock, anyone who can open your browser profile can open Iskra. Malware running as you can read keys from memory. Lock your devices, and use an app lock on shared computers.
- **Forward secrecy has limits:** it covers messages once their prekey is deleted (at most about five weeks after sending). A device that hasn't published a prekey (an older app version) gets messages wrapped to its long-term key instead: still end-to-end encrypted, without forward secrecy, and a server could hold back prekeys to force that.
- **Safety numbers are opt-in.** Until you compare them, you trust that the server showed you the right person the first time.
- **Calls use one key for the whole call**; there's no key change mid-call. Calls are one-to-one.
- **Profile pages:** if you turn a page's scripts on, blocking WebRTC inside it is best effort, since browsers don't cover it with the usual policy, so its author could learn your IP address. A page may show images uploaded to its own server, and that server can see when they're loaded.

## The desktop app

The desktop app is the same web app in a locked-down shell: sandboxed, no Node.js in the page, links open in your browser, and the page can only ask the app for push-to-talk, the screen picker, call alerts, updates, opening the system's privacy settings, and hosting.

- **Windows:** every executable we ship is code-signed (Open Source Developer Viktor Lundgren, issued by Certum) and timestamped, so you can check it came from us and wasn't changed. The installer only installs updates signed with that same certificate.
- **macOS and Linux** (with the next release): the macOS app is ad-hoc signed but not yet notarized by Apple, and the Linux packages aren't signed. Download them only from the GitHub releases page.
- Servers you create in the app run on your computer and only open ports to the internet when you switch on **Open to the internet**.

## Found a problem?

Please open an issue on [GitHub](https://github.com/quikmn/iskra-voice/issues), or for something sensitive, email the maintainer (address on the GitHub profile) before making it public.
