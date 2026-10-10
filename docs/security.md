# How Iskra keeps you safe

Iskra is built so that **nobody has to trust a company**, and so you only have to trust the people you actually rely on.

## Your account is a key

There's no email and no password. On first launch the app creates a key pair on your device; the public half *is* your account. Each device gets its own key, certified by your account key.

- Joining a server means signing a fresh challenge from that server. Nobody can join as you without your device, and a login meant for one server can't be replayed against another.
- Names aren't unique, keys are. If you want to be sure who someone is, compare **safety numbers** (open a DM, click *Verify*).
- Your **recovery key** (Settings → Recovery key) restores your account on a new device. It's the only copy outside your devices, so keep it somewhere safe, like a password manager. Anyone who has it can use your account.

## Who can read what

| What | Protected by | Who can read it |
|---|---|---|
| Everything on the wire | HTTPS / WSS (when the server has HTTPS) | You and the server |
| Server channels, voice, files | The server's permissions | Members allowed in that channel, and whoever runs the server |
| Direct messages | **End-to-end encryption** | Only the two of you |

Server channels trust the server, because a server is run by you or your friend; the app always tells you which server you're on. Direct messages don't trust anyone: servers only pass encrypted envelopes along.

### Direct messages in detail

- Encrypted with XChaCha20-Poly1305; the key is wrapped for each of the recipient's devices and your own (libsodium `crypto_box`).
- The sender, recipient, time and message id are bound into the encryption, so a message can't be altered, replayed or moved to another conversation.
- Device keys come with certificates signed by the account, so a server can't slip in a device of its own.
- There's no unencrypted fallback: if a message can't be encrypted, it isn't sent.
- What a server still sees: who messages whom and when.
- Not yet: forward secrecy (a ratchet or MLS). It's on the roadmap.

## What servers do to protect members

- Identity comes only from the signed handshake; every request and every broadcast is checked against your role *at that moment*.
- Private channels never leak, not even their existence.
- Uploads are checked by content, never by name. Only real images, video and audio display inline; everything else is a download, served with headers that stop it from running as part of the site.
- Link previews are fetched by the server so your IP isn't sent to every site, and the fetcher refuses private and internal addresses (also through redirects).
- Rate limits, size limits and strict input validation on everything.
- Who's in a voice channel comes only from the voice service's signed reports, never from what a client claims.

## The desktop app

The Windows app is the same web app in a locked-down shell: sandboxed, no Node.js in the page, links open in your browser, and the page can only ask the app for push-to-talk, the screen picker and hosting. It's not code-signed yet, which is why Windows asks before the first run.

## Found a problem?

Please open an issue on [GitHub](https://github.com/quikmn/iskra-voice/issues), or for something sensitive, email the maintainer (address on the GitHub profile) before making it public.
