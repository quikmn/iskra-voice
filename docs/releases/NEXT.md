<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new
- Themes: all of them reworked so menus sit above the panel they open from, hover and selected rows show, text steps down clearly, and red only ever means danger. New: Iskra Light and Midnight (true black for OLED screens). Theme cards show a small picture of the app in that look.
- Fonts are now their own setting (My settings → Appearance → Font): Inter, System, Rounded, Serif or Monospace, plus a code font. Inter, Nunito and JetBrains Mono ship with the app, so the text looks the same on every device. Built-in themes no longer change your font; a theme file that names one does while "Use the theme's font when it names one" is on.

### Fixes
- White text and icons on red (hang up, unread badges, recording) and on green (accept, join) now read clearly in every theme, and the keyboard focus ring shows in every theme.
- Encrypted channels stay encrypted on your device even if a server stops saying they are: nothing is sent in them then, and a message that arrives unencrypted is never shown as a member's. Encrypted whiteboards ignore anything unencrypted.
- Desktop: players in chat can no longer open your browser or pop-out windows by themselves.
- Desktop: a bot from a folder asks again before running when its code changed, and bots get only the parts of the app's environment they need.
- Desktop: another account on the same computer no longer sees the owner link of a server you made, also after a restart.
- Moderation: timed-out members and people who haven't agreed to the rules can no longer post through suggestions, looking-for-group posts, rooms, giveaways or other side doors; suggestions also go through AutoMod.
- Moderation: moderators can't read notes about, or ban, people ranked above them, also after those people left.
- Voice lobbies: one person can't fill the server with rooms from several windows, and room names go through AutoMod.
- Join requests: the waiting list is capped and counts toward raid protection, approving checks the invite still works, and a fresh invite lets in someone who was turned down.
- A picture that is also on a whiteboard stays when its disappearing message goes.
- Backup buddies: a server asks you before pairing with an address on your local network, and refuses unsigned uploads that would eat its memory.
- Android: swiping the app away in a call now ends the call and gives other apps their sound back; leftover shared files are cleaned up.
- Desktop: Electron security update.
- Desktop: no more freeze at start-up after a crash left bots behind, and two screen-share requests at once no longer mix up their answers.

### Good to know
- Fonts are now their own setting: if a theme used to give you a different font (Graphite, Solarized, Synthwave, Cyber-Lime), you now see Inter; pick another in My settings → Appearance → Font.
