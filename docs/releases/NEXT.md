<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new
- Write bots in Python too: the new Python SDK does commands, buttons, forms, cards and encrypted DMs, and any other language works through `npx iskra-bots bridge -- <your program>`, which just reads and writes JSON lines (no HTTP API, no open ports).
- A new hosting guide on iskra.foo/hosting walks you through the three ways to run a server, with pictures from the app, and every guide the app links to now opens as a page on iskra.foo instead of on GitHub.
- Export channels: admins can download channels (with threads, forum posts, docs pages and files) as a page that opens in any browser, even offline, plus JSON for programs. Encrypted channels and direct messages are never exported.
- Feeds, a new built-in bot: new blog posts (RSS or Atom), YouTube videos and, with your own Twitch app, Twitch streams going live are posted in the channel you pick, optionally pinging a role. It's off until an admin turns it on, since your server then checks those sites itself (text only, never pictures).

### Fixes

### Good to know
