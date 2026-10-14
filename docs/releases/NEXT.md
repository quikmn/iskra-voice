<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new
- **Report a bug from inside the app.** Press Ctrl+Shift+B (or My settings → Report a bug), say what happened, and it goes straight to the Iskra team, with screenshots of Iskra's own window if you want. You choose whether the app's recent logs go along; they never contain your messages, names, servers, links or addresses, and you can see exactly what's sent first. Server owners can run their own bug inbox too, in Server settings → Bug inbox.
- **AFK channel.** People who sit idle in voice are moved to the AFK channel, muted and deafened. Set the channel and the wait (5, 15, 30 or 60 minutes, or never) in Server settings → Voice. The Gaming and Friends templates come with one.
- **The built-in roles show up in Server settings → Roles.** Owner, Admin and Member list what they can do, and you can change their colour.
- **Richer GitHub cards in webhook channels:** the full commit subject, its first paragraph, how many files changed, up to 8 commits per push, and the release notes on a new release.
- **Thinner scrollbars** that follow your theme.

### Fixes
- Clicking a message no longer leaves its action bar and frame showing; they show while you hover, or when you move around with the keyboard.
- Connecting to DigitalOcean now always uses the same local port, which DigitalOcean requires. If that port is busy, the app offers to paste a token instead.

### Good to know
- Bug reports go to Iskra's own server (chat.iskra.foo), into a private channel only the Iskra team reads. Leave the email field empty to stay anonymous.
