# Listing text (DigitalOcean Marketplace)

For the vendor portal's listing form. Field lengths aren't public: shorten in the portal if it asks. DigitalOcean's
rules: write "DigitalOcean" (one word), say that DigitalOcean doesn't build or support the software, and don't
disparage other products.

## App name

Iskra

## Tagline

Your own voice and text chat server for your friends. Free, no ads, no tracking.

## Version and OS

Iskra `<version in the snapshot name>` on Ubuntu 24.04 LTS. The server updates itself to new Iskra releases.

## Description

Iskra is a voice and text chat app for friend groups: text channels, voice and video rooms, screen sharing, direct
messages and calls, threads, polls, emoji and soundboards, roles and moderation. This droplet is your group's own
Iskra server, with voice included.

Your friends use the free Iskra apps for Windows, Mac, Linux, iPhone and Android, or any browser at app.iskra.foo.
They join with an invite link you send them.

It's yours: messages, files and members live on this droplet, nowhere else. Iskra (the project) runs nothing for your
server and can't see it. Direct messages are end-to-end encrypted, and channels can be too, so the server can't
read them.

What it costs: only the droplet. The $6 size (1 GB) is plenty for a friend group. Iskra itself is free.

What's set up for you: HTTPS with a free certificate for a ready-made address (`<your-ip>.sslip.io`), automatic Iskra
updates, daily backups on the droplet, Ubuntu security updates, and a firewall that only lets in what Iskra needs.

DigitalOcean doesn't build or support Iskra. Support comes from the Iskra project (below).

## Software included

| Software | Version | License |
|---|---|---|
| Iskra server | as in the snapshot name | PolyForm Noncommercial 1.0.0 |
| LiveKit server (voice and video) | 1.13.7 | Apache 2.0 |
| .NET runtime (inside the Iskra server) | 10 | MIT |
| Ubuntu | 24.04 LTS | various open source |

## Getting started

1. Create the droplet: pick a region near your group and the $6 size. DigitalOcean asks for a password or an SSH key;
   pick either, you won't need it for Iskra.
2. Wait about a minute, then open the droplet's **Console** (on the droplet's page in DigitalOcean).
3. The console shows your server's **address** and a **claim code**. The code works once, for 24 hours.
4. Open the Iskra app (download it at iskra.foo, or use app.iskra.foo in a browser). Choose **Join a server → Claim
   it**, enter the address and the claim code, and press **Join as owner**.
5. You're the owner. Click **Invite friends** to get a link for your group.

If the code expired before you used it, power-cycle the droplet (Power → Power cycle) and open the Console again for a
new one. A brand-new droplet needs a few minutes to get its HTTPS certificate; if the app says the server doesn't
answer, try again shortly.

Firewall (ufw): 22/tcp (SSH and the DigitalOcean console), 80/tcp and 443/tcp (the website and its certificate),
7881/tcp and 7882/udp (voice and video). Everything else is closed.

Documentation: https://iskra.foo/docs/hosting#digitalocean-marketplace

## Support

- Email: spark@iskra.foo
- Issues: https://github.com/quikmn/iskra-voice/issues
- Website: https://iskra.foo

## Keywords

discord alternative, voice chat, self-hosted chat, gaming voice, community, team chat, video calls

## Categories

Communication (or the closest the portal offers), then Collaboration.
