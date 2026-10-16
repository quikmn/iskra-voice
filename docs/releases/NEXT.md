<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new
- Follow people or roles: right-click someone (or a role group) in the member list to hear about their posts in that channel like a mention, in your inbox and as a notification; manage follows under My settings → Notifications.
- Events can repeat every day, week, two weeks or month (with an optional end date): the next one is planned when the current one ends, you can change or cancel just one or the whole series, and the calendar file carries the repeat.

### Fixes
- Self-hosting: a server bound to `127.0.0.1` (`Https.BindAddress`) without `Https.ProxyProtocol` now warns at start that every client looks like the machine itself (one shared rate limit, no addresses in the security log).
- Event reminders no longer cover the message box on phones.
- The "keep using Iskra" bug report chip and the incoming-call screen now respect the notch and the home bar on phones.
- The soundboard, status menu and profile card no longer stick out past the screen edge on narrow phones.
- Screen readers now announce who is speaking in a voice channel.
- The desktop app's own messages (update check, About) now appear inside Iskra instead of as Windows pop-up boxes.
- The channel list, chat and members list now sit as rounded panels on the dark frame, and the bottom bars line up.

### Good to know
