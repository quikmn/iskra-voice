# Hosting an Iskra server

An Iskra server is **a folder**. Everything lives in it: settings, members, messages, files and keys. Copy the folder to back it up or move it to another machine.

There are three ways to run one:

| | Best for | Friends can join from |
|---|---|---|
| **The desktop app** (Windows) | Trying it out, LAN parties, friends at home or anywhere | Desktop app; any browser once it's open to the internet |
| **The standalone server** on your PC | Always-on server at home | Desktop app; any browser once it's open to the internet |
| **The standalone server on a VPS** (Linux) | Friends all over the place, 24/7 | Desktop app and any browser (with HTTPS) |

## 1. From the desktop app

Install Iskra, click **Create a server**, pick a name. Done: the server runs on your PC (voice included) while the app is open, and you're its owner. Click **Invite friends** to get a link.

- Its folder is `Documents\Iskra\Servers\<name>`.
- Friends on the same network can join right away. For friends elsewhere, turn on **Settings → Open to the internet** (see [Reaching your server from the internet](#reaching-your-server-from-the-internet)).

## 2. The standalone server

Download `iskra-server` for [Windows or Linux](https://github.com/quikmn/iskra-voice/releases) and unpack it. Voice (LiveKit) is included.

```sh
iskra-server my-server        # Windows: iskra-server.exe my-server
```

- The folder `my-server` is created on first run.
- The server prints a **one-time owner link** (also saved as `my-server/owner-invite.txt`). Open it in the Iskra app or at [app.iskra.foo](https://app.iskra.foo) to become the owner. The file disappears once used.
- Stop the server with Ctrl+C. Start it again with the same command; everything is kept.

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
ExecStart=/opt/iskra/iskra-server /opt/iskra/world
Restart=on-failure
# Lets the server use ports 80 and 443 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now iskra
sudo journalctl -u iskra -f        # shows the owner link on first start
```

## Reaching your server from the internet

### One switch: Open to the internet

As the owner, open **Settings** in the app and turn on **Open to the internet**. Iskra then:

1. **Asks your router to open the ports** (UPnP or NAT-PMP): outside `80/tcp` and `443/tcp` to the server's port, and voice `7881/tcp` and `7882/udp` (your `Voice` ports). It keeps them open while the server runs and closes them when it stops.
2. **Gives your server a free address** that points at your public IP, like `203-0-113-7.sslip.io`.
3. **Gets a real HTTPS certificate** for it from Let's Encrypt, so friends can join from any browser, phone included.
4. **Tells voice** your public address.

A checklist shows how each step went, in plain words. New invite links use the public address. Iskra re-checks every few minutes, so a router restart or a new IP from your provider is picked up by itself.

**When it can't work, it says why:**

- **Your router doesn't answer** (UPnP is off): turn on UPnP in the router's settings, or forward the ports it lists by hand, then press **Check again**.
- **The router won't open port 80** (many only allow ports above 1024): forward port 80 by hand. Until then friends with the desktop app can join over plain HTTP; browsers need HTTPS.
- **Carrier-grade NAT**: some providers share one public address between customers (your router's "public" address is then in `100.64.0.0/10` or another private range). No router setting helps; ask your provider for a public IPv4 address, or [run the server on a VPS](#on-a-linux-vps-with-systemd).

**What "reachable" means.** Iskra doesn't use outside services to test your server, so it only reports what it can actually prove: *verified* once Let's Encrypt has connected to your server from the internet, or *checked through your router* when the server can reach itself via your public address. Otherwise it says it hasn't been confirmed from outside; send a friend an invite to try.

**Why sslip.io.** [sslip.io](https://sslip.io) (and its twin nip.io) is a long-running free wildcard DNS service: `1-2-3-4.sslip.io` resolves to `1.2.3.4`, with nothing to sign up for. Let's Encrypt issues certificates for its names and has granted it a very large rate limit (sslip.io isn't on the Public Suffix List, so all its users share the per-domain limit; the operators have had it raised to 250,000 certificates a week). The address follows your IP, so if your provider changes it, the address and certificate change too and older invite links stop working. For stable links, use your own domain (a free dynamic-DNS name works) and set it as `Internet.Domain`.

Prefer to forward ports yourself? Set `"PortMapping": false` and your `Domain` in the `Internet` section, and forward `80/tcp` and `443/tcp` to the server's port plus the two voice ports.

### Your own domain and HTTPS setup

On a VPS, or if you'd rather set things up yourself:

1. **Ports.** Open (or forward on your router) the server's port, `47070/tcp` by default, and voice: `7881/tcp` and `7882/udp`. With HTTPS, open `80/tcp` and `443/tcp` instead of 47070.
2. **Address.** Set `PublicUrl` in `server.json` to how friends reach you, e.g. `http://203.0.113.5:47070` or `https://chat.example.com`. Invite links use it.
3. **HTTPS (needed for browsers).** Browsers only connect to servers with HTTPS. Iskra gets a free certificate from Let's Encrypt by itself; you need a domain (or a free one from a dynamic-DNS service) pointing at your server:

```jsonc
"Https": { "Mode": "acme", "Domain": "chat.example.com", "Email": "you@example.com" }
```

Restart the server. It answers Let's Encrypt on port 80, stores the certificate in `certs/`, renews it automatically, and redirects plain HTTP to HTTPS. Have your own certificate? Use `"Mode": "files"` with `CertFile` and `KeyFile` (PEM).

## `server.json` reference

```jsonc
{
  "Name": "Game Night",
  "Port": 47070,                       // the server's port: HTTP, plus HTTPS when open to the internet (localhost-only with Https on)
  "PublicUrl": null,                   // how friends reach the server; default http://localhost:<Port>, or https://<Domain>
  "AppUrl": "https://app.iskra.foo",   // the web app invite links open
  "MaxUploadMb": 100,                  // largest file a member may upload
  "Voice": {
    "Enabled": true,
    "LiveKitPath": null,               // default: next to iskra-server, then $ISKRA_LIVEKIT, then PATH
    "Port": 7880,                      // LiveKit's local API (not exposed; voice signaling goes through the server port)
    "RtcTcpPort": 7881,
    "RtcUdpPort": 7882,
    "ClientUrl": null                  // override the voice URL clients use (default <PublicUrl>/livekit)
  },
  "Https": {
    "Mode": "off",                     // "off" | "acme" (Let's Encrypt) | "files"
    "Domain": null,
    "Email": null,
    "CertFile": null, "KeyFile": null, // PEM, for "files"
    "Port": 443,
    "HttpPort": 80
  },
  "Internet": {                        // "Open to the internet" (the switch in Settings)
    "Enabled": false,
    "Domain": null,                    // your own domain pointing at your network; default <ip>.sslip.io
    "DnsSuffix": "sslip.io",
    "PortMapping": true                // ask the router to open ports (UPnP / NAT-PMP); false to forward them yourself
  }
}
```

## What's in the folder

| File | What it is |
|---|---|
| `server.json` | Settings (above) |
| `server.key` | The server's identity. Invite links pin it, so clients know they reach the real server. Keep it secret, keep it with the folder. |
| `iskra.db` | Members, channels, messages, roles, invites, direct-message envelopes (encrypted end to end) |
| `uploads/` | Uploaded files, stored once per unique content |
| `livekit.key` | Keys between the server and its voice service |
| `certs/` | HTTPS certificates (when HTTPS is on, or open to the internet) |
| `server.log` | Output, when started from the desktop app |

**Backups:** stop the server and copy the folder. **Moving:** copy the folder to the new machine, run it there, and update `PublicUrl` if the address changed; members and links keep working because the server's identity travels with it. **Updating:** replace the `iskra-server` and `livekit-server` files and start it again.

## Roles and moderation

`guest < member < trusted < admin < owner`. Each channel has a role needed to see it and a role needed to post (or speak, in voice). Admins can kick and ban people ranked below them and hand out roles below their own; the owner can do everything. Invite links can carry a role and expire after 1 hour to 30 days, optionally single use.
