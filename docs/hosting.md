# Hosting an Iskra server

An Iskra server is **a folder**. Everything lives in it: settings, members, messages, files and keys. Copy the folder to back it up or move it to another machine.

There are three ways to run one:

| | Best for | Friends can join from |
|---|---|---|
| **The desktop app** (Windows) | Trying it out, LAN parties, friends on your network | The desktop app |
| **The standalone server** on your PC | Always-on server at home | Desktop app; browsers too once HTTPS is set up |
| **The standalone server on a VPS** (Linux) | Friends all over the place, 24/7 | Desktop app and any browser (with HTTPS) |

## 1. From the desktop app

Install Iskra, click **Create a server**, pick a name. Done: the server runs on your PC (voice included) while the app is open, and you're its owner. Click **Invite friends** to get a link.

- Its folder is `Documents\Iskra\Servers\<name>`.
- Friends on the same network can join right away. For friends elsewhere, see [Reaching your server from the internet](#reaching-your-server-from-the-internet).

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
  "Port": 47070,                       // plain HTTP port (localhost-only when HTTPS is on)
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
| `certs/` | HTTPS certificates (when HTTPS is on) |
| `server.log` | Output, when started from the desktop app |

**Backups:** stop the server and copy the folder. **Moving:** copy the folder to the new machine, run it there, and update `PublicUrl` if the address changed; members and links keep working because the server's identity travels with it. **Updating:** replace the `iskra-server` and `livekit-server` files and start it again.

## Roles and moderation

`guest < member < trusted < admin < owner`. Each channel has a role needed to see it and a role needed to post (or speak, in voice). Admins can kick and ban people ranked below them and hand out roles below their own; the owner can do everything. Invite links can carry a role and expire after 1 hour to 30 days, optionally single use.
