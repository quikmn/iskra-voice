<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new

- Join-to-create voice rooms: admins can make a voice channel a lobby, and whoever joins it gets a room of their own under it, which they can rename, limit and lock; empty rooms clean themselves up.
- Streamer mode (My settings, or your status menu): hides invite links, account ids, safety numbers and email addresses in profiles, keeps notifications and sounds quiet, and shows a small pill while it's on; the desktop app can turn it on by itself while a program from your list (OBS, Streamlabs, …) is running.

### Fixes
- Self-hosting: a server bound to `127.0.0.1` (`Https.BindAddress`) without `Https.ProxyProtocol` now warns at start that every client looks like the machine itself (one shared rate limit, no addresses in the security log).
- Event reminders no longer cover the message box on phones.
- The "keep using Iskra" bug report chip and the incoming-call screen now respect the notch and the home bar on phones.
- The soundboard, status menu and profile card no longer stick out past the screen edge on narrow phones.
- Screen readers now announce who is speaking in a voice channel.
- The desktop app's own messages (update check, About) now appear inside Iskra instead of as Windows pop-up boxes.
- The channel list, chat and members list now sit as rounded panels on the dark frame, and the bottom bars line up.

### Good to know
