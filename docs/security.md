# How Iskra keeps you safe

Iskra is built so that **nobody has to trust a company**, and so you only have to trust the people you actually rely on.

## Your account is a key

There's no email and no password. On first launch the app creates a key pair on your device; the public half *is* your account. Each device gets its own key, certified by your account key.

- Joining a server means signing a fresh challenge from that server. Nobody can join as you without your device, and a login meant for one server can't be replayed against another.
- Names aren't unique, keys are. If you want to be sure who someone is, compare **safety numbers** (open a DM, click *Verify*).
- Your **recovery key** (Settings → Recovery key) restores your account on a new device. It's the only copy outside your devices, so keep it somewhere safe, like a password manager. Anyone who has it can use your account.

## Your devices

- **Linking a device** (Settings → Devices → Link a device) moves your account to a phone or another computer without typing the recovery key. The code holds a one-time secret that never reaches the server; both devices prove they know it, then both screens show the same six-digit number before anything is sent. Your account is encrypted from one device straight to the other (libsodium `crypto_box`), so the server that relays it can't read it or slip in a device of its own. Codes expire after five minutes and work once.
- **Removing a device** (Settings → Devices) signs a revocation with your account key and hands it to every server you're on. Servers then refuse that device, sign it out, and stop listing it, and senders stop encrypting messages for it.
- Every linked device holds your account key (that's what lets it link and remove devices too). Removing a device stops it from connecting and from getting new messages. If you think a device was copied while it was unlocked, treat it like a leaked recovery key: whoever copied it could set up a new device as you.

## Who can read what

| What | Protected by | Who can read it |
|---|---|---|
| Everything on the wire | HTTPS / WSS (when the server has HTTPS) | You and the server |
| Server channels, voice, files | The server's permissions | Members allowed in that channel, and whoever runs the server |
| Direct messages | **End-to-end encryption** | Only the two of you |

Server channels trust the server, because a server is run by you or your friend; the app always tells you which server you're on. Direct messages don't trust anyone: servers only pass encrypted envelopes along.

### Direct messages in detail

- Encrypted with XChaCha20-Poly1305; the key is wrapped for each of the recipient's devices and your own.
- **Forward secrecy.** Each device has a short-lived encryption key (a *prekey*), signed by the device, replaced every week and deleted 30 days after that. Each message's key is sealed to the recipient devices' current prekeys with a fresh one-time key (libsodium `crypto_box_seal`, around a `crypto_box` from the sender's device that proves who sent it). Once a prekey is deleted, messages sealed to it can't be decrypted again, even by someone who later steals your devices' long-term keys and every encrypted message a server ever stored. Your app keeps the messages it has already decrypted on the device, so your history stays readable.
- Why not a ratchet like Signal's: a conversation here travels over whichever server you share, across several devices each, which are often offline for days. Weekly prekeys give forward secrecy without per-device session state that can get out of step. There's no "healing" after a break-in, though: a stolen device can read new messages until you remove it.
- The sender, recipient, time and message id are bound into the encryption, so a message can't be altered, replayed or moved to another conversation.
- Device keys come with certificates signed by the account, so a server can't slip in a device of its own.
- There's no unencrypted fallback: if a message can't be encrypted, it isn't sent.
- What a server still sees: who messages whom and when.
- A device that hasn't published a prekey (an older app version) gets the message wrapped to its long-term key instead: still end-to-end encrypted, without forward secrecy. A server could hold back prekeys to force that.

## What servers do to protect members

- Identity comes only from the signed handshake; every request and every broadcast is checked against your role *at that moment*.
- Private channels never leak, not even their existence.
- Uploads are checked by content, never by name. Only real images, video and audio display inline; everything else is a download, served with headers that stop it from running as part of the site.
- Link previews are fetched by the server so your IP isn't sent to every site, and the fetcher refuses private and internal addresses (also through redirects).
- Rate limits, size limits and strict input validation on everything.
- Who's in a voice channel comes only from the voice service's signed reports, never from what a client claims.

## The desktop app

The Windows app is the same web app in a locked-down shell: sandboxed, no Node.js in the page, links open in your browser, and the page can only ask the app for push-to-talk, the screen picker and hosting. Every Windows executable we ship is code-signed (Open Source Developer Viktor Lundgren, issued by Certum) and timestamped, so you can check it came from us and wasn't changed.

## Found a problem?

Please open an issue on [GitHub](https://github.com/quikmn/iskra-voice/issues), or for something sensitive, email the maintainer (address on the GitHub profile) before making it public.
