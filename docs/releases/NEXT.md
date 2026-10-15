<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new
- **The privacy list is complete**: Privacy & data now names every service the apps and your server may contact, including link previews, translation models and the STUN lookup voice may use, with when it happens and how to turn it off.
- **Two servers on one machine**: behind a TLS-passthrough proxy (nginx `stream`), a server can listen on 127.0.0.1 only (`Https.BindAddress`) and still see each member's real address (`Https.ProxyProtocol`). See "Two servers on one machine" in the hosting guide.

### Fixes
- **Desktop updates arrive by themselves again.** The desktop app could stop finding new versions on its own while an unfinished release was the newest one on GitHub ("Check for updates" in the tray still worked). Update checks are now also written to logs/updates.log in the app's data folder.

### Good to know
