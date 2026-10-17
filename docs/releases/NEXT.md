<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new
- Media channels: a channel that's a gallery. Share screenshots, art and memes as posts of pictures and videos with captions, tags and comments, browse them as a grid, sort by newest or most reactions, and open any post full screen with its comments beside it. Sensitive posts stay blurred until someone chooses to look.
- On your phone, back always does what you expect: it closes what's open, then shows your channels, then takes you back to the channel; press it twice quickly to leave the app. Swipe right for your channels and left for the member list; the drawers follow your finger.
- Voice channel status: give a voice channel a line like "CS2 ranked 🔫" so everyone sees what's going on; it clears itself when the call ends. And pick your own notification sounds for messages, mentions and DMs, per server or per channel, or use your own short sound (it stays on your device).
- Three more built-in bots: Starboard shows your server's best messages in #starboard, Birthdays wishes members a happy birthday (day and month only, and only if they share it), and Welcome greets newcomers in your own words.
- Voice messages as text: tap Show transcript and your device writes out what was said, nothing is uploaded, and it works in encrypted chats too. Have messages read aloud with your device's own voices, one at a time or every new message in a channel while you game, and send /tts messages that friends who opt in hear read aloud.
- Invites can have a label ("Reddit post"), and moderators see which invite each person joined with, with a "Joined with" filter in Server settings → Members.
- Webhooks take GitHub, Gitea, GitLab and Slack formats directly (add /github, /gitea, /gitlab or /slack to the URL), with an optional signing secret so only your repository can post.
- Outgoing webhooks can also send voice joins and leaves, new threads, edits and deletions, member and role changes, and channel changes.
- Feeds, a new built-in bot: new blog posts (RSS or Atom), YouTube videos and, with your own Twitch app, Twitch streams going live are posted in the channel you pick, optionally pinging a role. It's off until an admin turns it on, since your server then checks those sites itself (text only, never pictures).

### Fixes
- A server you saved stays in your list when it can't be reached (for example away from home) and keeps trying to reconnect; it's never removed by itself. Joining voice on your other device now says so instead of silently dropping you.
- Listen together: a link you type while the previous one is still being added no longer disappears, and someone still answering "watch from another site?" no longer keeps hearing the last item or skips the party ahead for everyone.

### Good to know
