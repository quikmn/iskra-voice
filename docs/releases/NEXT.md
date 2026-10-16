<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new

### Fixes
- Self-hosting: a server bound to `127.0.0.1` (`Https.BindAddress`) without `Https.ProxyProtocol` now warns at start that every client looks like the machine itself (one shared rate limit, no addresses in the security log).

- Event reminders no longer cover the message box on phones.
- The "keep using Iskra" bug report chip and the incoming-call screen now respect the notch and the home bar on phones.
- The soundboard, status menu and profile card no longer stick out past the screen edge on narrow phones.
- Screen readers now announce who is speaking in a voice channel.

### Good to know
