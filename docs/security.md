# How Iskra keeps you safe

Iskra is built so that **nobody has to trust a company**, and so you only have to trust the people you actually rely on.

## Your account is a key

There's no email and no password. On first launch the app creates a key pair on your device; the public half *is* your account. Each device gets its own key, certified by your account key.

- Joining a server means signing a fresh challenge from that server. Nobody can join as you without your device, and a login meant for one server can't be replayed against another.
- Names aren't unique, keys are. If you want to be sure who someone is, compare **safety numbers** (open a DM, click *Verify*).
- Your **recovery key** (Settings → Recovery key) restores your account on a new device. It's the only copy outside your devices, so keep it somewhere safe, like a password manager. Anyone who has it can use your account.

## Your devices

- **Linking a device** (Settings → Devices → Link a device) moves your account to a phone or another computer without typing the recovery key: scan the QR code or type the code. The code holds a one-time secret that never reaches the server; both devices prove they know it, then both screens show the same six-digit number before anything is sent. Your account is encrypted from one device straight to the other (libsodium `crypto_box`), so the server that relays it can't read it or slip in a device of its own. Codes expire after five minutes and work once.
- **Removing a device** (Settings → Devices) signs a revocation with your account key and hands it to every server you're on. Servers then refuse that device, sign it out, stop listing it and stop sending it push notifications, and senders stop encrypting messages for it.
- Every linked device holds your account key (that's what lets it link and remove devices too). Removing a device stops it from connecting and from getting new messages. If you think a device was copied while it was unlocked, treat it like a leaked recovery key: whoever copied it could set up a new device as you.

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
- Rate limits, size limits and strict input validation on everything.
- Who's in a voice channel or call comes only from the voice service's signed reports, never from what a client claims.

### Profile pages

A profile page is HTML someone else wrote, so it's locked in a strict sandbox. It only loads when you click *Open profile page*, and then:

- it runs on an empty, throwaway origin: no cookies, no storage, no access to the app, your keys or the server;
- it has no network: it can't fetch anything, load outside images, fonts, audio or video, open pop-ups, submit forms or navigate anywhere, so its author can't learn your IP address or that you looked;
- it gets no camera, microphone, autoplay or other device access.

Admins can turn pages off for their server or remove a member's page.

### Themes

A theme is a JSON file of colours, sizes and font choices. Every value is checked against a strict pattern and applied one setting at a time, so a theme can't inject CSS or code.

### Push notifications

- Notifications go from your server through your browser's push service (Google, Apple, Mozilla or Microsoft), encrypted so that service can't read them.
- **DM notifications never contain the message**, just "New message from X". Mentions and replies carry a short excerpt from the channel.
- Each server has its own push key, and a subscription belongs to one device. Your server only accepts addresses at known push services and doesn't notify a device you're actively using.

### Webhooks and bots

- A webhook URL contains a long random secret. The server only stores a hash of it and shows the URL once; an admin can replace it at any time. Treat it like a password, and use the `https://` address.
- Webhook posts can't ping anyone unless an admin allows it for that webhook, and images from the payload are dropped, so a webhook message can't make viewers' apps contact a third-party address.
- Bots are marked with a **BOT** badge, can only join with a single-use bot invite from an admin, can't join voice or create invites, and can't be made admin.

## Limitations

We'd rather tell you than have you find out:

- **Server channels, voice channels and files are not end-to-end encrypted.** Whoever runs the server can read them.
- **Metadata.** Servers see who messages and calls whom, when, and for how long. Your push service sees when you get a notification.
- **Your device holds your keys and your decrypted DM history unencrypted** (in the browser's storage, or the desktop app's data folder). Anyone with access to your unlocked device or user account can read them. Lock your devices.
- **Forward secrecy has limits:** it covers messages once their prekey is deleted (at most about five weeks after sending). A device that hasn't published a prekey (an older app version) gets messages wrapped to its long-term key instead: still end-to-end encrypted, without forward secrecy, and a server could hold back prekeys to force that.
- **Safety numbers are opt-in.** Until you compare them, you trust that the server showed you the right person the first time.
- **Calls use one key for the whole call**; there's no key change mid-call. Calls are one-to-one.
- **Profile pages:** blocking WebRTC inside a page is best effort, since browsers don't cover it with the usual policy. A page may show images uploaded to its own server, and that server can see when they're loaded.
- **Webhooks:** on a server without HTTPS, the secret in a webhook URL travels in plain text.

## The desktop app

The desktop app is the same web app in a locked-down shell: sandboxed, no Node.js in the page, links open in your browser, and the page can only ask the app for push-to-talk, the screen picker, call alerts, updates, opening the system's privacy settings, and hosting.

- **Windows:** every executable we ship is code-signed (Open Source Developer Viktor Lundgren, issued by Certum) and timestamped, so you can check it came from us and wasn't changed. The installer only installs updates signed with that same certificate.
- **macOS and Linux** (with the next release): the macOS app is ad-hoc signed but not yet notarized by Apple, and the Linux packages aren't signed. Download them only from the GitHub releases page.
- Servers you create in the app run on your computer and only open ports to the internet when you switch on **Open to the internet**.

## Found a problem?

Please open an issue on [GitHub](https://github.com/quikmn/iskra-voice/issues), or for something sensitive, email the maintainer (address on the GitHub profile) before making it public.
