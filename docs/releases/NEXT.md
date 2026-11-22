<!-- Release notes for the next version. Each change is its own line; the release step merges them. -->

### What's new
- Getting started is two short steps in one card, and fits small laptop screens without scrolling.
- A message's "⋯" menu no longer covers the member list.
- A server emoji that is missing or still loading shows as a small `:name:` chip instead of a broken image.
- Watch parties: the player's controls now sit on the video and step aside while you watch; speed and the host's settings are behind the gear, and End is in the panel's header.
- Whiteboards have a floating toolbar over the canvas, with shapes, colour and size one tap away, on phones and in calls too.
- Stop a recording straight from the call screen or the voice bar; activities are turned on or off per voice channel with a switch.

### Fixes
- Encrypted channels: hiding a channel moments after it was set up no longer lets a new key be accepted later without the "started over" warning.
- Voice clips: in direct and group calls, everyone now sees that your clips are on, even if they connected after you.
- Standalone servers with the peer-to-peer tunnel: the tunnel could start before the server was ready and stay off; it now waits.
- Windows servers stay responsive while voice and the tunnel run (their output no longer ties up the server's worker threads).

### Good to know
- Iskra is in the DigitalOcean Marketplace: "Deploy Iskra on DigitalOcean" makes a ready server with voice and HTTPS, and you claim it from the app with the code on its console ([hosting guide](https://iskra.foo/docs/hosting#digitalocean-marketplace)).
