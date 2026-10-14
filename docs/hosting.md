# Hosting an Iskra server

> **Your server, your choice.** Iskra gets nothing from any of this; this is just a guide.

An Iskra server is **a folder**. Everything lives in it: settings, members, messages, files and keys. Back it up from the app with one click and restore it on any machine (see [Backups, moving and importing](#backups-moving-and-importing)).

There are three ways to run one:

| | Best for | Friends can join from |
|---|---|---|
| **The desktop app** (Windows, macOS and Linux) | Trying it out, LAN parties, friends at home or anywhere | Desktop app; any browser and phone once it's open to the internet |
| **The standalone server** on your PC | Always-on server at home | Desktop app; any browser and phone once it's open to the internet |
| **The standalone server on a VPS** (Linux) | Friends all over the place, 24/7, or when your home connection can't host ([rent one from the app](#rent-a-small-server)) | Desktop app and any browser (with HTTPS) |

## 1. From the desktop app

Install Iskra, click **Create a server**, pick a name and a starting point (a [starter template](#starter-templates): *Gaming group*, *Friends hangout*, *Board games and tabletop* or *Empty*). Done: the server runs on your PC (voice included) while the app is open, and you're its owner. Click **Invite friends** to get a link.

- Its folder is `Documents\Iskra\Servers\<name>` (on macOS: `~/Library/Application Support/Iskra/Servers/<name>`).
- Friends on the same network can join right away. For friends elsewhere, turn on **Let friends anywhere join** in **Server settings → Internet access** (see [Reaching your server from the internet](#reaching-your-server-from-the-internet)).
- The server stops when you quit the app. Tick **Keep my server running** (when it's created, or in **Server settings → Internet access**): Iskra then starts with your computer, hidden in the tray, and starts that server; closing the window keeps it running. Untick it on the last such server and Iskra stops starting with the computer too.

## 2. The standalone server

Download `iskra-server` for [Windows, Linux or macOS](https://github.com/quikmn/iskra-voice/releases) and unpack it. Voice (LiveKit) is included.

```sh
iskra-server my-server        # Windows: iskra-server.exe my-server
```

- The folder `my-server` is created on first run.
- The server prints a **one-time owner link** (also saved as `my-server/owner-invite.txt`). Open it in the Iskra app or at [app.iskra.foo](https://app.iskra.foo) to become the owner. The file disappears once used.
- Stop the server with Ctrl+C. Start it again with the same command; everything is kept.
- Start from a template: `iskra-server my-server --template gaming` (see [Starter templates](#starter-templates)).

### Keep it running (start with the computer)

```sh
iskra-server install-autostart my-server     # and to undo it: iskra-server remove-autostart my-server
```

Nothing starts right away (stop the copy in your terminal first, then use the "start it now" command it prints). What it sets up:

| System | What | When it starts |
|---|---|---|
| Windows | A scheduled task, *Iskra server &lt;folder&gt;-&lt;hash&gt;*, running without a window (`conhost --headless`), output appended to `server.log`, restarted if it crashes, no time limit | When you log in. Run from an **administrator** terminal and it starts with the computer instead, before anyone logs in (as you, without storing your password: "S4U"; never with administrator rights) |
| Linux | A systemd **user** service, `~/.config/systemd/user/iskra-<folder>-<hash>.service`, enabled | When you log in. `loginctl enable-linger $USER` makes it start at boot. As root it refuses: use the system unit below |
| macOS | A launchd agent, `~/Library/LaunchAgents/foo.iskra.server.<folder>-<hash>.plist`, output to `server.log`, restarted if it crashes | When you log in |

Installing and removing are written to the server's security log.

### Starter templates

A new server can start with channels, voice rooms, roles and rules from a template. It's applied **once**, on the first start of a new server (nobody has joined, nothing has been set up yet). On a server that's already in use it's ignored, so a leftover setting never adds channels to it. Built in: `gaming`, `friends`, `tabletop`, `empty`. List them with `iskra-server templates`.

- In the desktop app: the second step of **Create a server**.
- Standalone: `iskra-server my-server --template gaming`, or `"Template": "gaming"` in `server.json` before the first start.
- Your own: a `.json` file, by path (`--template ./book-club.json`). Check one with `iskra-server templates ./book-club.json`: it prints what it would set up, or exactly what's wrong. A bad template stops the server from starting, with that message.

```jsonc
{
  "name": "Book club",                         // 1–60 characters
  "description": "Reading together.",          // optional, up to 300
  "channels": [                                // optional: outside any category, listed first
    { "name": "Reading room", "kind": "voice", "userLimit": 8 }
  ],
  "categories": [                              // optional, up to 50
    {
      "name": "Books",                         // 1–32 characters
      "channels": [
        { "name": "now-reading" },             // "kind": "text" (default) or "voice"; names 1–32 characters
        { "name": "announcements", "writeRole": "admin" }   // readRole/writeRole: guest, member (default), trusted, admin
      ]
    }
  ],
  "roles": [                                   // optional, up to 20, highest first
    { "name": "Moderator", "color": "#3fa66b", "icon": "📚", "hoist": true, "mentionable": false,
      "permissions": ["manageMessages", "timeoutMembers", "kickMembers", "muteMembers", "moveMembers", "viewAuditLog"] }
  ],
  "rules": { "text": "Be kind.", "welcome": "Welcome!", "required": false },  // optional; rules up to 6000, welcome up to 500 characters
  "afk": { "channel": "Reading room", "minutes": 30, "canTalk": ["owner", "admin", "Moderator"] }   // optional: the AFK channel
}
```

- `userLimit` (voice only): 0 (no limit) to 99. At most 100 channels in all.
- `afk` (optional): `channel` names one of the template's voice channels; people idle in voice for `minutes` (5, 15, 30 or 60; 0 = never move anyone; default 30) are moved there. In it everyone is muted and deafened by the server except the levels (`owner`, `admin`, `trusted`, `member`, `guest`) and template roles (by name) listed in `canTalk` (default `["owner", "admin"]`). Admins can change all of it later in **Server settings → Voice**. The `gaming` and `friends` templates have an AFK channel.
- Permissions: `manageMessages`, `timeoutMembers`, `kickMembers`, `banMembers`, `manageChannels`, `manageRoles`, `viewAuditLog`, `manageExpressions`, `manageWebhooks`, `mentionEveryone`, `moveMembers`, `muteMembers`, `manageAutoMod`.
- The server's starting `#general` becomes the template's first text channel. Comments and trailing commas are fine; unknown fields are an error (so typos don't go unnoticed). Files can be up to 64 KB. Applying one is written to the security log.

### Rent a small server

When your home connection can't host (carrier-grade NAT, or a router you can't change), a small virtual server at a hosting company runs Iskra for your group all the time. The app walks you through it: **Server settings → Internet access → Rent a small server** (it's the first option when Iskra finds a shared connection). No terminal needed; about 15 minutes. Your group picks the provider, pays it and owns the server; nothing goes to Iskra. The desktop app can also do all of it on DigitalOcean for you: see [Rent a server on DigitalOcean](#rent-a-server-on-digitalocean-one-click).

1. Make an account at a VPS provider, for example [Hetzner](https://www.hetzner.com/cloud) or [DigitalOcean](https://www.digitalocean.com/products/droplets).
2. Create a server: **Ubuntu 24.04 LTS** (or **Debian 12**), x86-64, the cheapest plan (about €4–6 a month).
3. Paste the app's **setup text** into the **User data** box (Hetzner: "Cloud config"; DigitalOcean: "Advanced options → Add initialization scripts") and create the server.
4. Paste the server's IPv4 address into the app and press **Connect**. The app waits while the server installs (usually 3–10 minutes, at most 20), checks that it really is the server you set up, and makes you its owner.

**What the setup text does** (a bash script that cloud-init runs once, as root, on first boot; its log is `/var/log/iskra-setup.log`):

- downloads `iskra-server-<version>-linux-x64.tar.gz` (the version of your app) and `SHA256SUMS.txt` from the release on GitHub over HTTPS, and stops unless the package matches its checksum;
- unpacks it into `/opt/iskra`, owned by a new system user `iskra`, and installs the systemd service shown below (restarts on failure, [automatic updates](#updating) on);
- opens only `22/tcp` (SSH, so your provider's tools keep working), `80/tcp`, `443/tcp`, `7881/tcp` and `7882/udp` with ufw;
- writes `server.json` with HTTPS on for `<your-ip-with-dashes>.sslip.io` (a free certificate from Let's Encrypt), your server's name and starting point, and a **one-time owner key**.

**The owner key.** The app makes 32 random bytes, `OwnerClaim` in `server.json`. On its first start the server moves it out of `server.json` into `owner-claim` (readable by the server only) and makes the owner invite from it; the key and that invite are never written to a log. The app checks a proof made with the key before it trusts the server (so a different server at that address can't pretend), then joins as owner, and the key is deleted. Until then the app keeps the key in its encrypted store (like your account keys; protected by the system keychain in the desktop app), so closing the dialog doesn't lose it; **Start over with a new owner key** deletes it. Keep the setup text to yourself until then; afterwards it's useless. Your provider can see the setup text (like everything on a server you rent from them).

**Rather use a terminal?** The same dialog has **Copy a prompt for an AI assistant** with these steps, and no keys in it. Without the app's key you become the owner the usual way: `journalctl -u iskra` shows the link (also in `/opt/iskra/world/owner-invite.txt`).

**Moving an existing server there** takes a terminal for now: make a backup, copy it to the server, stop the service, [restore it](#restoring) into `/opt/iskra/world` (empty the new folder first), `chown -R iskra:iskra /opt/iskra`, start it again, then use [Move this server](#moving-a-server-to-another-computer) so everyone follows.

### Rent a server on DigitalOcean (one click)

The desktop app can rent and set up the server in **your own DigitalOcean account**: **Create a server → Rent one on DigitalOcean** (also offered in Rent a small server). You pay DigitalOcean directly, about $6 a month for their smallest server that fits Iskra (1 GB memory; the app shows the exact price from DigitalOcean's size list before anything is created). Iskra charges nothing, runs nothing for your server and never sees it, your token or your card. The account link is Iskra's DigitalOcean referral link, and the app says so: Iskra gets some DigitalOcean credit, which helps pay for its own server, and new DigitalOcean accounts get signup credit.

1. **Account.** Make a DigitalOcean account, or use the one you have.
2. **Access.** **Connect to DigitalOcean** opens your browser: sign in and allow Iskra. The app uses OAuth for a desktop app (authorization code with PKCE, no client secret): your browser comes back to a one-time listener on `127.0.0.1` (this computer only, a random port, closed right after), and the app swaps the code for a key that works for one hour. It asks only for `droplet:create droplet:read droplet:delete firewall:create firewall:read firewall:delete regions:read sizes:read tag:create`.
   **Or use an API token:** in DigitalOcean, API → Tokens → Generate New Token, the shortest expiration (30 days, or Custom), **Custom Scopes** with only *droplet* (create, read, delete), *firewall* (create, read, delete), *regions* (read), *sizes* (read) and *tag* (create), and paste it into the app.
3. **Server.** Pick a location (the app guesses the nearest from your time zone), a name and a starting point. SSH stays closed unless you tick **Also allow SSH**.
4. **Create.** The app creates, through DigitalOcean's API (`api.digitalocean.com`, HTTPS):
   - a droplet `iskra-<name>`: Ubuntu 24.04, the cheapest basic size with at least 1 GB, tag `iskra`, monitoring and DigitalOcean's paid backups off, with the same [setup text](#rent-a-small-server) as user data (it carries the one-time owner key, turns on automatic updates and daily backups);
   - a cloud firewall `iskra-<name>-firewall` for that droplet only: in `80/tcp`, `443/tcp`, `7881/tcp`, `7882/udp` (plus `22/tcp` only if you asked), out everything.

   Then it waits for the droplet's IPv4 address (up to 5 minutes) and for `https://<ip-with-dashes>.sslip.io/health` to answer with a valid Let's Encrypt certificate (up to 25 minutes), checks the owner proof and joins you as owner.
5. **Your server document.** **Save your server document** saves a Markdown file (in your language) with the address, how friends join, where your keys and recovery live, the monthly cost and how to cancel, how updates, backups and moving work, what Iskra can and can't see, and a ready-to-copy prompt for an AI assistant that describes the setup exactly (Ubuntu version, the `iskra` service, `/opt/iskra`, ports, logs). It holds no token, keys or passwords.

**The key stays on your computer.** The OAuth key or pasted token lives only in the desktop app's main process memory: it's sent only to `api.digitalocean.com`, never shown back to the page, logged or written to disk, and forgotten when setup finishes, the dialog closes, the page reloads, or after two hours at most. You can also delete a pasted token in DigitalOcean afterwards.

**If something fails** the app says what went wrong (in DigitalOcean's own words too) and, if a droplet was already created, offers **Delete it at DigitalOcean** (the firewall, then the droplet). Closing the dialog during setup asks whether to delete or keep what was made; nothing paid is left behind without asking. If the server is slow to answer, **Keep waiting** tries for another 20 minutes.

**SSH.** Closed by default: nobody needs to log in to run Iskra. To use SSH or DigitalOcean's Droplet Console, add an inbound rule for TCP 22 to the droplet's firewall (Networking → Firewalls); ufw on the droplet already allows it.

**Cancelling.** Destroy the droplet in DigitalOcean (Droplets → the droplet → Destroy); a switched-off droplet still costs money. Then delete its firewall. Make a [backup](#backups) first if you want to keep the history.

### On a Linux VPS with systemd

```sh
sudo useradd --system --create-home --home-dir /opt/iskra iskra
sudo tar -xzf iskra-server-*-linux-x64.tar.gz -C /opt/iskra --strip-components=1
sudo chown -R iskra:iskra /opt/iskra
```

`/etc/systemd/system/iskra.service`:

```ini
[Unit]
Description=Iskra server
After=network-online.target

[Service]
User=iskra
WorkingDirectory=/opt/iskra
# Undoes an automatic update that doesn't start (see Updating). Optional, but needed for automatic updates.
ExecStartPre=-/opt/iskra/iskra-update-guard
ExecStart=/opt/iskra/iskra-server /opt/iskra/world
Restart=on-failure
RestartSec=5
# Lets the server use ports 80 and 443 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now iskra
sudo journalctl -u iskra -f        # shows the owner link on first start
```

**Restarting without friends seeing "went offline".** systemd stops the server the same way for a restart as for a
stop, so by default members see *"<server> went offline"*. Say it's a restart first, and they see *"restarting, hold
on"* and are back within seconds:

```sh
sudo -u iskra /opt/iskra/iskra-server expect-restart /opt/iskra/world --reason update --eta 30
sudo systemctl restart iskra
```

`expect-restart` leaves a small marker (`restart-expected`) in the server folder holding only the reason (`update`
or `restart`, the default) and the expected downtime in seconds (`--eta`, 0–600, optional). The server reads it as it
stops and deletes it; a marker older than 2 minutes is ignored, so a restart that didn't happen doesn't turn a later
stop into "restarting". Put it in your own update scripts just before the restart. Or make `systemctl reload iskra`
the friendly restart by adding this to the unit:

```ini
ExecReload=/opt/iskra/iskra-server expect-restart /opt/iskra/world
ExecReload=+/bin/systemctl --no-block restart %n
```

### Updating

As the owner, open **Server settings → Server updates**. It shows the version the server runs and whether a newer one is out (the owner also gets a short notice above the chat). Choose what happens when one is:

| | What it does | Where |
|---|---|---|
| **Off** | Never looks for new versions | Everywhere |
| **Tell me** (default) | Looks at [GitHub releases](https://github.com/quikmn/iskra-voice/releases) every 6 hours and tells you | Everywhere |
| **Install automatically** | Also installs it, in the hour after a time you pick (`04:00` by default, server time), once nobody is in a voice channel. **Update now** installs it right away | Linux, run by systemd as above |

**Installing by hand** (Windows, macOS, or "Tell me"): stop the server, unpack the new `iskra-server` package over the old files (the server folder, e.g. `my-server`, isn't in the package and stays as it is), start it again. A server started by the desktop app updates together with the app and never checks by itself.

**How an automatic update works:**

1. The server downloads the package for its system (`iskra-server-<version>-linux-x64.tar.gz`) and the release's `SHA256SUMS.txt`, from `github.com/quikmn/iskra-voice` over HTTPS only.
2. It checks the package's SHA-256 against `SHA256SUMS.txt` **and** against the checksum GitHub lists for the file, verifies its signed build attestation (see the trust model below), and that the archive holds nothing but plain files at its top level. It runs the new `iskra-server version` to make sure it starts on this machine. Anything that doesn't match stops the update; nothing has been replaced yet.
3. It swaps the new files in (the old ones go to `.update/previous/` next to `iskra-server`), tells everyone *"restarting for an update"*, and exits; systemd starts the new version a few seconds later. Members' apps reconnect by themselves.
4. The new version confirms itself after running for a minute. If it fails to start three times before that, `iskra-update-guard` puts the previous version back and the owner sees *"the update didn't start"*; that version isn't tried again automatically.

Every check you start, change of setting, install, failure, finished update and rollback is written to the security log (**Server settings → Sign-ins & security**).

Automatic updates need: the systemd unit above with the `ExecStartPre` line (Server settings → Server updates says so if it's missing; `iskra-update-guard` comes in the Linux package), and the server's user owning the folder `iskra-server` is in (`chown -R iskra:iskra /opt/iskra`). Updates never touch the world folder. Database changes in new versions are forward-only, so a rolled-back version runs on a database the new one may already have migrated; that's why a version only confirms after it has started cleanly, and why daily backups exist.

**What the checks prove (trust model).** The download comes over TLS from GitHub, and the checksums come from the same GitHub release. That catches corrupted or truncated downloads and anyone tampering between GitHub and you. It does *not* protect against someone who can publish releases on the Iskra repository, since they could replace the package and `SHA256SUMS.txt` together. For that, releases carry [build-provenance attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations), and the server verifies them itself before installing (on by default: **Check the signed build attestation**). It gets the Sigstore bundles for the exact file from GitHub and checks them on the server, with Sigstore's root built into Iskra: the signature must come from Iskra's release workflow running on GitHub's own runners for this version (not from a person's account), be in Sigstore's public transparency log, and name this file with its SHA-256. Someone who only gets into the GitHub account can still publish a release, but can't make a matching attestation for a changed file without also changing the release workflow, which shows in the public log. A release without an attestation (or one that doesn't verify) is never installed automatically; **Server settings → Server updates** says why, and you can install it by hand. Turning the check off (in Server settings → Server updates, or `"VerifyAttestation": false` in server.json) is logged and shows a warning. Sigstore adds new signing keys now and then; a server too old to know a new one refuses that update with *"doesn't verify"* until you update it by hand once. To check a file yourself: `gh attestation verify <file> -R quikmn/iskra-voice`. If you'd rather review every release first, use **Tell me**.

The server only asks GitHub's public API (no account; 60 requests an hour per IP, and an unchanged list doesn't count), and tells GitHub nothing beyond what any request does (its IP address) and its version in the `User-Agent`.

### Health check

`GET /health` answers `{"iskra":1,"status":"ok","version":"…","uptimeSeconds":…,"voice":"up"}` (`voice` is `up`, `down` or `off`): nothing private, for an uptime monitor. `GET /` answers `{"iskra":1,"name":…}` as before.

## Reaching your server from the internet

### One switch: Let friends anywhere join

As the owner, open **Server settings → Internet access** in the app and turn on **Let friends anywhere join**. This works the same for a server in the desktop app and for the standalone server at home. Iskra then:

1. **Asks your router to open the ports** (UPnP or NAT-PMP): outside `80/tcp` and `443/tcp` to the server's port, and voice `7881/tcp` and `7882/udp` (your `Voice` ports). It keeps them open while the server runs and closes them when it stops.
2. **Gives your server a free address** that points at your public IP, like `203-0-113-7.sslip.io`.
3. **Gets a real HTTPS certificate** for it from Let's Encrypt, so friends can join from any browser, phone included.
4. **Tells voice** your public address.

A checklist shows how each step went, in plain words. New invite links use the public address. Iskra re-checks every few minutes, so a router restart or a new IP from your provider is picked up by itself.

Below it, **What Iskra found out**: whether your router has its own public address, a shared one (carrier-grade NAT, `100.64.0.0/10`) or another private one (a second router or your provider's NAT in front: double NAT), whether it refused some ports, its make and model when UPnP says, and the exact voice ports. All of this comes from your router's own answers and your computer; no outside service is asked.

**Forward the ports yourself** lists, step by step, your router's settings page (its address on your network), this computer's address, and every port with its protocol. **Copy a prompt for an AI assistant** fills in a question for ChatGPT, Gemini, Claude or any other assistant with your system, router model, those two local addresses and the ports, and shows it in a box you can edit before copying. It never includes your public address, keys or invite links.

**When it can't work, it says why:**

- **Your router doesn't answer** (UPnP is off): turn on UPnP in the router's settings, or forward the ports it lists by hand, then press **Check again**.
- **The router won't open port 80** (many only allow ports above 1024): forward port 80 by hand. Until then friends with the desktop app can join over plain HTTP; browsers need HTTPS.
- **Carrier-grade NAT**: some providers share one public address between customers (your router's "public" address is then in `100.64.0.0/10` or another private range). Port forwarding on your own router can't help: the provider's NAT sits in front of it. Friends behind such a connection can always *join* a reachable server; only the person hosting needs an open connection. The app lists the options, quickest first:
  1. For a server in the desktop app: [let friends connect without port forwarding](#let-friends-connect-without-port-forwarding-experimental) (experimental), nothing to open and nothing to install.
  2. [Rent a small server](#rent-a-small-server), ready in about 15 minutes, paid and owned by your group.
  3. Check whether you already have a public IPv4 address (many fiber connections do): the check shows what your router says.
  4. Ask your provider for a public IPv4 address. Often free and done once; mobile broadband (4G/5G) almost never gets one.
  5. [Use Tailscale (free)](#use-tailscale-free): a free app that links your group's devices as if they were on one network. Everyone installs it once; no ports to open.
  6. Let someone in your group with an open connection host: the server is one folder, so [move it](#moving-a-server-to-another-computer).

**What "reachable" means.** Iskra doesn't use outside services to test your server, so it only reports what it can actually prove: *verified* once Let's Encrypt has connected to your server from the internet, or *checked through your router* when the server can reach itself via your public address. Otherwise it says it hasn't been confirmed from outside; send a friend an invite to try.

**Why sslip.io.** [sslip.io](https://sslip.io) (and its twin nip.io) is a long-running free wildcard DNS service: `1-2-3-4.sslip.io` resolves to `1.2.3.4`, with nothing to sign up for. Let's Encrypt issues certificates for its names and has granted it a very large rate limit (sslip.io isn't on the Public Suffix List, so all its users share the per-domain limit; the operators have had it raised to 250,000 certificates a week). The address follows your IP, so if your provider changes it, the address and certificate change too and older invite links stop working. For stable links, use your own domain (a free dynamic-DNS name works) and set it as `Internet.Domain`.

Prefer to forward ports yourself? Set `"PortMapping": false` and your `Domain` in the `Internet` section, and forward `80/tcp` and `443/tcp` to the server's port plus the two voice ports.

### Let friends connect without port forwarding (experimental)

For a server hosted in the desktop app, **Server settings → Internet access → Connect without port forwarding** lets friends in even when your connection is shared (CGNAT) or your router won't open ports. It's off until the owner turns it on, and marked experimental until it has been tried on more connections.

**How it works.** Your desktop app announces a key on [HyperDHT](https://github.com/holepunchto/hyperdht), the public peer-to-peer network that Keet and other Pear apps use (the same idea as BitTorrent's DHT). A friend's desktop app gets the key from your invite link, looks your computer up there, and the two apps punch a path straight to each other through both routers (UDP hole punching, as game consoles and video calls do). Everything then travels inside an encrypted connection ([Noise](https://noiseprotocol.org/) over UDX) directly between your computers: chat, files, and voice through the server's own TURN relay. Nothing of Iskra's is in between; the only fixed points are HyperDHT's three bootstrap nodes (run by Holepunch), used once to find other nodes. Iskra's own signed handshake and the invite code still decide who may join, and the server key in the link still pins your server end to end.

**What to expect.** From a home connection (a usual router, or a provider's shared address that follows the rules) friends can connect straight to you, including friends on mobile data. When *both* ends give every destination a new port (some mobile networks and strict corporate NATs), the hole punch fails and the friend can't connect yet; the switch's panel says which kind of connection you have. A relay run by a group member is planned for that case.

**What it shows others.** The nodes near your key on the network (anyone can run one) see your internet address and the addresses of friends who look you up, for as long as the feature is on and the key stays the same. They don't see what you host, who your members are, or anything you say. **New key** changes the key: old invite links then stop working this way, and members get the new one from the server by themselves. "Who Iskra talks to" in My settings lists this too.

**Invite links** get a fourth part, the connection key. Old three-part links keep working. Friends' apps try your address first and use the tunnel only when it can't be reached; browsers and phones can't do this yet and need a reachable address.

**Under the hood.** The server listens on a second port on `127.0.0.1` only (written to `p2p.port` in the folder), where the app's tunnel delivers friends with their real address (PROXY protocol v2), so they count as remote visitors in every way: rate limits, the security log, never the trust the server gives its own machine. Voice uses LiveKit's embedded TURN server on `Voice.TurnUdpPort` (default `RtcUdpPort + 1`) with relay ports 40000–40200, allowed to relay only to this computer; the friend's app reaches it at `127.0.0.1` through the tunnel and sends media relay-only. While your voice goes through a tunnel, the desktop app runs WebRTC with Chromium's `default_public_interface_only` policy (one any-address socket; with a socket per network adapter, Windows can't reach loopback) and switches back when you leave, so voice to a server on another local network (Tailscale, ZeroTier, a second router) keeps using the right adapter. The secret is in `p2p.key` (owner-only). Development builds and `LocalOnly` servers never touch the public network; tests use a private DHT on `127.0.0.1`.

**Third-party notices (the peer-to-peer stack, bundled with the desktop app):**

| Component | Version | License |
|---|---|---|
| [hyperdht](https://github.com/holepunchto/hyperdht) (Holepunch) | 6.34.1 | MIT |
| [dht-rpc](https://github.com/holepunchto/dht-rpc) | 6.27.0 | MIT |
| [@hyperswarm/secret-stream](https://github.com/holepunchto/hyperswarm-secret-stream) (Noise over UDX) | 6.9.2 | Apache-2.0 |
| [noise-handshake](https://github.com/holepunchto/noise-handshake), [noise-curve-ed](https://github.com/chm-diederichs/noise-curve-ed) | 4.2.0, 2.1.0 | Apache-2.0, ISC |
| [udx-native](https://github.com/holepunchto/udx-native) (UDX streams over UDP; native addon) | 1.21.3 | Apache-2.0 |
| [sodium-native](https://github.com/holepunchto/sodium-native), [sodium-universal](https://github.com/holepunchto/sodium-universal) (libsodium; native addon) | 5.1.0, 5.0.1 | MIT |
| [blind-relay](https://github.com/holepunchto/blind-relay) | 1.6.1 | Apache-2.0 |
| [protomux](https://github.com/holepunchto/protomux), [compact-encoding](https://github.com/holepunchto/compact-encoding), [b4a](https://github.com/holepunchto/b4a), [streamx](https://github.com/mafintosh/streamx) and the other small Holepunch libraries they pull in | as in `desktop/package-lock.json` | MIT and Apache-2.0 |

### Use Tailscale (free)

> **Your server, your choice.** Iskra gets nothing from this; it's just a guide.

**Why you need this.** Your internet provider shares one internet address between many homes (this is called CGNAT). That's normal, but it means nobody outside can reach a server on your computer, and opening ports can't fix it. [Tailscale](https://tailscale.com) is a free app that connects your group's computers and phones as if they were on the same network, so your friends can reach your Iskra server directly.

**What it costs and what it sees.** Tailscale's Personal plan is free for personal, non-commercial use: up to 6 people and as many devices as you like. You share only the computer that runs your server, and each friend uses their own free Tailscale account (terms checked 2026-10-12 on [tailscale.com/pricing](https://tailscale.com/pricing); they can change). Tailscale sees which devices connect to which, and when, not what you say, write or share: that travels encrypted (WireGuard). It tries a direct connection first and falls back to Tailscale's relays, so it works even when everyone is behind CGNAT. Tailscale is a separate company's service: Iskra doesn't run it, isn't part of your account and never sees it, and you can remove it any time.

**You (on the computer that runs the server):**

1. Install Tailscale from [tailscale.com/download](https://tailscale.com/download).
2. Open Tailscale and sign in with Google, Microsoft, Apple or GitHub. The free Personal plan is picked for you.
3. Share this computer with one link: on Tailscale's **Machines** page (login.tailscale.com), find this computer, choose **Share…** and copy the share link (let it be used more than once). Send it to your friends.
4. In Iskra, open **Invite friends** and choose **Over Tailscale** (it appears once Tailscale is on), then send that invite. It points at your computer's Tailscale address, like `http://100.101.102.103:47070`. **Server settings → Internet access** shows the same address.

**Each friend:**

1. Installs Tailscale from [tailscale.com/download](https://tailscale.com/download) (Windows, Mac, Linux, iPhone or Android) and signs in with their own Google, Microsoft, Apple or GitHub account.
2. Opens your share link and presses **Accept**. They only see your computer, nothing else.
3. Keeps Tailscale on, opens your Iskra invite in the Iskra app and joins. Chat, voice and video work as usual.

**How Iskra handles it.** Iskra finds Tailscale on its own computer only from the network interfaces (an address in `100.64.0.0/10` on Tailscale's adapter: `Tailscale` on Windows, `tailscale0` on Linux, a `utun` interface on macOS); it never asks Tailscale's service or app. Friends who connect over a Tailscale address (or a MagicDNS name ending in `.ts.net`) get voice through that same address, and voice advertises this computer's own addresses, Tailscale's included, so voice and video work over it. Friends on your home network keep using the usual invite. The link is plain HTTP, which is fine here: Tailscale encrypts the whole path, and Iskra's own end-to-end encryption for DMs and private channels works as always. Browsers need HTTPS, so friends join with the Iskra app.

**If friends can't connect:** check that Tailscale is on for both of you, that your share link was accepted, and that your computer is awake. Windows may ask once to allow Iskra on the network: choose **Allow**. You can also put the address in `server.json` yourself, `"PublicUrl": "http://100.101.102.103:47070"` (your address, or your `.ts.net` name): then every invite uses it, and voice still works.

### Your own domain and HTTPS setup

On a VPS, or if you'd rather set things up yourself:

1. **Ports.** Open (or forward on your router) the server's port, `47070/tcp` by default, and voice: `7881/tcp` and `7882/udp`. With HTTPS, open `80/tcp` and `443/tcp` instead of 47070.
2. **Address.** Set `PublicUrl` in `server.json` to how friends reach you, e.g. `http://203.0.113.5:47070` or `https://chat.example.com`. Invite links use it.
3. **HTTPS (needed for browsers).** Browsers only connect to servers with HTTPS. Iskra gets a free certificate from Let's Encrypt by itself; you need a domain (or a free one from a dynamic-DNS service) pointing at your server:

```jsonc
"Https": { "Mode": "acme", "Domain": "chat.example.com", "Email": "you@example.com" }
```

Restart the server. It answers Let's Encrypt on port 80, stores the certificate in `certs/`, renews it automatically, and redirects plain HTTP to HTTPS. Have your own certificate? Use `"Mode": "files"` with `CertFile` and `KeyFile` (PEM).

### Ports at a glance

| Port | What | When |
|---|---|---|
| `47070/tcp` (`Port`) | The server: app, invites, uploads, voice signaling, webhooks. Speaks HTTP and HTTPS on the same port. | Always |
| `80/tcp` → server port | Let's Encrypt's check, and redirects to HTTPS | Let friends anywhere join, or `Https` on |
| `443/tcp` → server port | HTTPS for friends | Let friends anywhere join, or `Https` on |
| `7881/tcp`, `7882/udp` | Voice and video media (`RtcTcpPort`, `RtcUdpPort`) | Always, for voice from outside your network |
| `7880` | LiveKit's local API | Never exposed |

### Push notifications

Nothing to set up. On first start the server makes its push key (`vapid.json`) and sends notifications for mentions, replies, DMs, group chats, calls and event reminders through the browsers' own push services (an outgoing HTTPS connection). Members turn them on per device in **My settings → Notifications**; on phones that needs the web app over HTTPS, and on iPhone and iPad the app added to the Home Screen. The phone apps show notifications while they're open.

### Voice, stages and watch parties

Voice channels, stages, DM and group calls and watch parties all use the same voice service (LiveKit), which the server starts and stops by itself: nothing extra to run or open beyond the voice ports above. Stages are voice channels where the server tells LiveKit who may speak. A watch party only shares a clock through the server; everyone's app plays the video from its source (YouTube, a link, or a file uploaded to your server, which then serves it to everyone watching).

### GIFs

The GIF picker uses [KLIPY](https://docs.klipy.com) (Google closed Tenor's API in June 2026). It's off until an admin adds a key:

1. Sign up at the KLIPY Partner Panel and create an API key for your server. Leave ads **off**.
2. In Iskra: **Server settings → GIFs**, paste the key and click **Turn on**.

There are two modes:

- **Through this server** (the default): your server searches KLIPY and passes the GIFs along, so members' devices never contact KLIPY: it only sees your server, and the key never leaves it. It uses your server's bandwidth for every GIF shown. KLIPY's standard terms describe apps calling KLIPY directly; if you want their written OK for proxying, ask developers@klipy.com.
- **Straight from KLIPY** (only if you pick it): members' apps search KLIPY and load GIFs from KLIPY themselves, so KLIPY sees their IP addresses and searches. The key is shared with your members' apps, which is fine for a key made just for your server. GIFs in messages load when clicked, unless someone turned on auto-load for their device (My settings → Appearance).

Everything else Iskra and your server talk to is listed in [Who Iskra talks to](privacy-connections.md).

To turn GIFs off, click **Turn off** there.

### Live captions

Members can turn on live captions in calls. The speech recognition runs on their own devices, but the speech model
(Whisper base, about 78 MB) comes from your server: the first time someone turns captions on, your server downloads
it once from Hugging Face (at a pinned version, every byte checked against pinned SHA-256 hashes) into the `models/`
folder, and serves it to members' apps from then on. So their devices only talk to your server, and Hugging Face only
sees your server, once. Only members get it: their app asks your server for a short-lived link first, so nobody else
can download it from your server or make it fetch the model. It takes about **78 MB of disk space** (plan for 100 MB). The security log notes the
download. To not offer captions at all, set `"Captions": { "ModelDownload":
false }` in server.json and restart; the apps then say this server doesn't offer captions. Deleting `models/` is
safe: it's fetched again the next time someone needs it.

The link is valid for an hour and only for that member; the app asks for a new one whenever it needs it. Apps from
before 2.0.0-alpha.13 download the model without a link, so an updated server refuses them: members who want captions
need an up-to-date app. How the link works: [PROTOCOL.md](../protocol/PROTOCOL.md#live-captions-model); what runs on
members' devices: [voice-processing.md](voice-processing.md).

### Bots and webhooks

Everything here is in **Server settings → Bots & webhooks**, for admins. Nothing runs or connects until an admin turns
it on. The details, and how to write your own bot: [bots.md](bots.md).

- **Built-in bots** (the **Bots** tab): **Dice** (`/roll 2d6+3`), **Polls** (`/poll Question | Answer | Answer`) and
  **Reminders** (`/remind me in 10m …`) run inside your server, so there's nothing to install or keep running. Turn
  one on and it joins as a bot member; change its role or the channel's overrides to choose
  where it answers. They read only their own commands and don't answer in encrypted channels.
- **Your own bots** (the **Bots** tab): make a single-use bot invite and start the bot with it. Leave **Can read all
  messages** off unless the bot needs to read along: then it gets only its commands, button clicks and forms, and
  messages that mention it or reply to it. You can change this later. Bots that joined before this choice existed
  keep reading everything until you turn it off.
- **Webhooks** (incoming): a secret URL that posts into one channel, for anything that can post to Discord, and GitHub.
- **Outgoing webhooks** (the **Outgoing** tab): your server sends chosen events (new messages or reactions in the
  channels you pick, people joining or leaving, events starting) as signed JSON to an `https://` address you choose,
  such as a Minecraft bridge or Home Assistant. Each one has its own signing secret (shown once; **New secret** makes
  another), a log of the last 50 deliveries and **Send a test**. Your server makes these requests, so the address
  sees your server's IP address and what the event contains (message text and names); nothing from encrypted
  channels, DMs or group chats is ever sent. Addresses on your own network (`http://` allowed there) are refused
  unless the owner ticks **Allow addresses on my own network** for that webhook. A webhook that keeps failing is
  turned off, and admins who are online are told. At most 10 per server. Every member sees where their server sends things under
  **My settings → Privacy & data → Who Iskra talks to**. The secrets are stored in the server's database, so they're
  in its backups too: keep backups private, and make a new secret if one leaks.

## Backups, moving and importing

### Backups

**Download one:** as the owner, open **Server settings → Backup & move**, choose a passphrase and click **Make backup**. You get one file (`<name>-<date>.iskrabackup`) with everything: messages, channels, members, roles, files, settings and the server's key. It's made while the server keeps running.

Because the file holds the server's key, it's always encrypted with your passphrase (Argon2id and XChaCha20-Poly1305 from libsodium). Keep the file and the passphrase in different places: without the passphrase nobody can open it, and nobody can recover it for you either.

**Daily backups:** every day the server also keeps a copy of the database, settings and keys in its own `backups/` folder (the last 7), so a bad disk write or a mistake can be undone. These aren't encrypted, since they sit next to the keys anyway (owner-only file permissions on Linux and macOS). Uploaded files stay in `uploads/`; turn on **Include uploaded files** if you want them copied too. Change this in **Server settings → Backup & move** or in `server.json` → `Backups`. A daily backup only helps while that disk is fine, so download one now and then as well.

From the command line (this works while the server runs, too):

```sh
iskra-server backup my-server my-server.iskrabackup      # asks for a passphrase
```

### Restoring

- **Desktop app:** **Create a server → Restore from a backup**, pick the file and enter the passphrase. The server starts on this computer with everything it had, on free ports and this network's address.
- **Standalone server:**

  ```sh
  iskra-server restore my-server.iskrabackup my-server    # asks for the passphrase
  iskra-server my-server
  ```

  The folder must be new or empty: a restore never overwrites a server. Daily backups (`backups/auto-*.zip`) restore the same way, without a passphrase. Check `Port` and `PublicUrl` in `server.json` if the new machine's address is different. HTTPS certificates aren't in backups; the new machine gets its own.

For scripts, `--passphrase-stdin` reads the passphrase from standard input (or set `ISKRA_BACKUP_PASSPHRASE`).

### Moving a server to another computer

Use **Server settings → Backup & move → Move this server**. It walks you through it:

1. **Back up** this server.
2. **Restore** the backup on the new computer (as above) and start it there. If friends join from outside your home, turn on **Let friends anywhere join** there, or set up HTTPS.
3. **Enter the new address.** Iskra connects to it and checks that it really is this server (it has the same key).
4. **Move everyone.** The old copy publishes a notice, *"this server moved to &lt;new address&gt;"*, signed with the server's key. Everyone's app checks the signature against the key it already trusts and switches to the new address by itself; people who are offline get it the next time they connect. From then on the old copy refuses new messages, so nothing gets lost in it.

Keep the old copy running for a few days so everyone gets the notice, then stop it, and share new invite links from the new address. Changed your mind? `iskra-server move <old-folder> --cancel` takes the notice down. With the old server stopped, `iskra-server move <old-folder> <new-address>` publishes one.

Members and their roles, channels and history all come along, because the server's identity travels with it. Direct messages are end-to-end encrypted: their envelopes come along too, and everyone's app keeps its own history.

### Importing from Discord

Bring your Discord server's history along with [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter):

1. Export the channels you want in the **JSON** format. Turn on **Download assets** (`--media` on the command line) to include files and profile pictures.
2. Zip the folder it made, or use a single `.json` file.
3. As the owner, open **Server settings → Import from Discord** and upload it. A progress bar shows how it's going, and you can keep chatting meanwhile.

Each Discord channel becomes a channel here (threads become threads), with its messages in order, their dates, replies, pins, files and reaction counts. Messages show their authors' Discord names and pictures with an **Imported from Discord** label: those people aren't accounts here, and nobody can edit those messages. Tick **read-only archive** to keep the imported channels for reading only. Each channel's Discord category is kept with it.

What doesn't come along: **roles and permissions** (DiscordChatExporter can't export them, so set up roles here and invite your friends), direct messages, and files that weren't downloaded with the export (their names are shown instead; Iskra never fetches anything from Discord). The upload is checked like any other: zip entries can't point outside the export, every file is typed by its content, and there are size limits (`Import.MaxMb`, 4 GB by default).

From the command line, best with the server stopped:

```sh
iskra-server import-discord my-server export.zip              # add --read-only for an archive
```

## `server.json` reference

```jsonc
{
  "Name": "Game Night",
  "Port": 47070,                       // the server's port: HTTP, plus HTTPS when open to the internet (localhost-only with Https on)
  "PublicUrl": null,                   // how friends reach the server; default http://localhost:<Port>, or https://<Domain>
  "AppUrl": "https://app.iskra.foo",   // the web app invite links open
  "Template": null,                    // starter template applied once to a new server: "gaming", "friends", "tabletop", "empty" or a .json path
  "OwnerClaim": null,                  // one-time owner key from "Rent a small server"; moved out of this file on first start
  "MaxUploadMb": 512,                  // largest file a member may upload (also in the app: Server settings → Limits)
  "UploadQuota": {                     // per account, over any 24 hours; 0 = no limit (admins and the owner have none)
    "MemberMbPerDay": 10240,           // members and trusted
    "GuestMbPerDay": 1024
  },
  "Limits": {                          // 0 = no limit (uploads still can't exceed MaxUploadMb)
    "SoundMaxSeconds": 0,              // soundboard sound length
    "SoundMaxMb": 0,
    "EmojiMaxKb": 1024,
    "StickerMaxKb": 4096
  },
  "LocalOnly": false,                  // true: listen on localhost only (testing; nobody else can connect)
  "Voice": {
    "Enabled": true,
    "LiveKitPath": null,               // default: next to iskra-server, then $ISKRA_LIVEKIT, then PATH
    "Port": 7880,                      // LiveKit's local API (not exposed; voice signaling goes through the server port)
    "RtcTcpPort": 7881,
    "RtcUdpPort": 7882,
    "ClientUrl": null,                 // override the voice URL clients use (default <PublicUrl>/livekit)
    "TurnUdpPort": 0,                  // LiveKit's TURN for friends through the p2p tunnel; 0 = RtcUdpPort + 1
    "TurnRelayStart": 40000, "TurnRelayEnd": 40200
  },
  "P2p": {                             // "Connect without port forwarding" (desktop app; Server settings → Internet access)
    "Enabled": false,
    "TunnelPort": 0                    // the tunnel's listener on 127.0.0.1; 0 = any free port, written to p2p.port
  },
  "Https": {
    "Mode": "off",                     // "off" | "acme" (Let's Encrypt) | "files"
    "Domain": null,
    "Email": null,
    "CertFile": null, "KeyFile": null, // PEM, for "files"
    "Port": 443,
    "HttpPort": 80
  },
  "Internet": {                        // "Let friends anywhere join" (Server settings → Internet access)
    "Enabled": false,
    "Domain": null,                    // your own domain pointing at your network; default <ip>.sslip.io
    "DnsSuffix": "sslip.io",
    "PortMapping": true                // ask the router to open ports (UPnP / NAT-PMP); false to forward them yourself
  },
  "Backups": {                         // daily backups in backups/ (Server settings → Backup & move)
    "Enabled": true,
    "Keep": 7,                         // how many days to keep (1–30)
    "IncludeUploads": false            // also copy uploads/ into each one
  },
  "Import": {
    "MaxMb": 4096                      // largest Discord export the owner may upload
  },
  "Updates": {                         // Server settings → Server updates (see Updating)
    "Mode": "notify",                  // "off" | "notify" (tell the owner) | "auto" (also install; Linux with systemd)
    "Channel": "stable",               // "stable" | "prerelease" (also test versions)
    "Window": "04:00",                 // automatic installs start within the hour after this (server time)
    "VerifyAttestation": true          // only install releases whose build attestation verifies (older "RequireAttestation" is ignored)
  },
  "Retention": {                       // how long data is kept, in days; 0 = forever (Server settings → Sign-ins & security)
    "MessagesDays": 0,                 // channel messages, and encrypted DM and group envelopes
    "UploadsDays": 0,                  // files in messages and DMs (avatars, emoji, stickers, sounds and event covers stay)
    "AuditDays": 90,                   // the audit log
    "SecurityLogDays": 365,            // the security log
    "SecurityLogIps": false            // also record IP addresses in the security log
  },
  "Captions": {                        // live captions (see Live captions)
    "ModelDownload": true              // offer the speech model (~78 MB, fetched once from Hugging Face into models/)
  }
}
```

## What's in the folder

| File | What it is |
|---|---|
| `server.json` | Settings (above) |
| `server.key` | The server's identity. Invite links pin it, so clients know they reach the real server. Keep it secret, keep it with the folder. |
| `iskra.db` | Members, channels, messages, roles, invites, direct-message envelopes (encrypted end to end) |
| `uploads/` | Uploaded files (including avatars, custom emoji and soundboard sounds), stored once per unique content |
| `livekit.key` | Keys between the server and its voice service (handed to LiveKit in its environment, never on the command line) |
| `vapid.json` | The server's push-notification key. Keep it with the folder: if it's lost, a new one is made and members turn notifications on again. |
| `certs/` | HTTPS certificates and the Let's Encrypt account (when HTTPS is on, or open to the internet) |
| `owner-invite.txt` | The one-time owner link, until the owner has joined |
| `owner-claim` | The one-time owner key from "Rent a small server", until the owner has joined |
| `p2p.key`, `p2p.port` | The key friends' invites carry for "Connect without port forwarding" (owner-only), and the port of the tunnel's listener on 127.0.0.1 (written at each start) |
| `backups/` | Daily backups (`auto-YYYY-MM-DD.zip`, not encrypted) and, briefly, a backup being downloaded |
| `moved.json` | The signed "this server moved" notice, after **Move this server** |
| `server.log` | Output, when started from the desktop app |
| `exports/` | "Download my data" files while their 10-minute link lasts (never in backups) |
| `models/` | The live-captions speech model, once someone has used captions (about 78 MB; never in backups, fetched again when needed) |

Profile pages, polls, threads, pins, forums, events, roles, groups (their encrypted messages), webhooks (only a hash of each secret), outgoing webhooks (with their signing secrets), built-in bots and push subscriptions are all in `iskra.db` too, so copying the folder takes everything along.

On Linux and macOS the server creates the folder (and `certs/`) readable by its own user only, writes secrets as `0600`, and tightens older secret files to `0600` when it starts.

Uploads that nothing uses (no message, DM, avatar, emoji, sticker, sound, webhook, event cover, profile page or running watch party) are deleted after a day.

**Security log and retention:** the owner reads the server's security log in **Server settings → Sign-ins & security** (failed sign-ins, new members and devices, key changes, account deletions, backups, moves, data downloads; IP addresses only if you turn that on) and sets how long messages, files, the audit log and the security log are kept. Deleting happens every hour and can't be undone. Members download what the server keeps about them in **Settings → Privacy & data**; if someone asks you instead, use **Someone's data** in Server settings → Sign-ins & security.

**Backups and moving:** see [Backups, moving and importing](#backups-moving-and-importing). Copying the stopped server's folder works too; it holds secrets (`server.key`, `vapid.json`, `livekit.key`, `certs/`, `backups/`), so keep copies private. **Updating:** see [Updating](#updating). Automatic updates keep their state in `.update/` next to `iskra-server`, not in the world folder.

## Roles and moderation

Everyone has a **base role**: `Guest < Member < Trusted < Admin < Owner`. Each channel has a base role needed to see it and one needed to post (or speak, in voice). Admins can kick and ban people ranked below them and hand out base roles below their own; the owner can do everything. Invite links can carry a base role and expire after 1 hour to 30 days, optionally single use.

On top of the base roles, admins can make **custom roles** (Server settings → Roles) with a name, colour and icon, and give them permissions such as managing messages, timing people out, kicking, banning, managing channels or roles, muting and moving people in voice, or mentioning everyone. Roles can also change what a channel allows (**per-channel overrides**), and roles can be made mentionable. Moderators have **timeouts**, **slowmode** per channel, **server mute** and **move** in voice, and an **audit log** of moderation actions (kept 90 days).
