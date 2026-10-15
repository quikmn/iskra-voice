<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new

- **Updates you can't miss**: a green button at the top of your server list until you're on the new version, and "Update ready" in the window title.
- **What's new card**: after an update, a short card shows the highlights once.
- **Restarting for an update**: when the desktop app updates while it hosts your server, friends see "restarting for an update" and rejoin by themselves.

- **Claim a server**: got Iskra from the DigitalOcean Marketplace? Copy the address and claim code from the droplet's console, choose Claim it in the app, and you're the owner.
- **Raspberry Pi and other ARM boxes**: the server now comes for 64-bit ARM Linux too. See "An Iskra box at home" in the docs.
- **Invites say where you're going**: an invite link greets you with the server's name.
- **On a phone, Start your own server** shows how to put Iskra on your computer, or rent a small server.

- **No port forwarding for standalone servers too**: turn on Connect without port forwarding and the server runs its own peer-to-peer tunnel (included in the server downloads).

- **Shape the built-in roles**: choose what Admins, Trusted, Members and Guests can do. The owner can never be locked out.
- **Templates**: save your server as a template, or start a new one from a template file, with every channel kind, who can see and use each channel, roles and settings. See what a template sets up before you create the server.
- **Default notifications**: admins choose whether new members hear about all messages or only @mentions.
- **Message a bot**: DMs with bots are end-to-end encrypted, its commands work right in the DM, and you choose whether bots may write to you first.
- **Music bot** (an example bot you can run): plays the songs your group uploads, with a queue, volume and a DJ role. Never YouTube or Spotify.

- **Invites that never expire**: admins can make a standing link to the server. Every active invite is listed in the Invite dialog, and any of them can be revoked with one click.

- **Pop-outs**: pop the voice panel, a screen share or camera, or a text channel into its own small window, always on top over your game. In Chrome and Edge, the voice panel and videos can go picture-in-picture.

- **Alert words and quiet hours**: get a ping when someone writes words you choose, matched on your own device, even in encrypted chats. Set quiet hours (say weeknights 22–07) and Iskra stays silent, with mentions let through if you like.
- **Code and math**: code blocks are syntax-highlighted and `$…$` renders as real math, without breaking "$5 and $10".
- **Disappearing messages**: a timer from 5 minutes to 4 weeks in any DM, group or channel. Messages and their files are deleted from the server and everyone's devices, even in encrypted chats, and backups never include them.
- **Whisper and priority speakers**: hold a key and only the people on your list hear you, or talk straight to another channel. Priority speakers make everyone else quieter while they talk. Enforced by your server.
- **Game nights**: split a voice channel into random or balanced teams (or let captains pick), each in its own channel, and bring everyone back with one tap. Post "Looking for 3 for Valheim tonight" and everyone gets a ping when the group is full.
- **Translate messages** on your own device, even in encrypted chats: nothing goes to a translation service. The server owner turns it on in Server settings → Translation.

### Fixes

- Voice through Connect without port forwarding no longer keeps reconnecting after the owner turns it on.
- Leaving voice while it was reconnecting could put you back in; now you really leave.

- Rent a server: "Connect to DigitalOcean" now finishes signing in (it stopped at the last step with "authorization grant is invalid").

### Good to know

- The grey theme "Iskra Dark" is now called Graphite. If you use it, you keep it.
