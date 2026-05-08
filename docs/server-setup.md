# Hosting an Iskra Server

This guide takes you from a blank VPS to a fully working Iskra server that supports:
- The desktop client (Windows)
- The web app at [app.iskra.foo](https://app.iskra.foo)
- The Android app
- Friends behind CGNAT (mobile data, shared IPs) via a TURN relay

**Time to complete:** ~20 minutes

---

## What you need

| Requirement | Notes |
|---|---|
| VPS | 1 GB RAM minimum. DigitalOcean, Hetzner, Linode all work. ~$5–6/mo. |
| OS | Ubuntu 22.04 LTS |
| Domain name | Any registrar. You need a DNS A record pointing at your VPS IP. |
| Open ports | See below |

### Ports to open

| Port | Protocol | Purpose |
|---|---|---|
| 80 | TCP | Let's Encrypt HTTP challenge |
| 443 | TCP | HTTPS / WSS (nginx) |
| 3478 | TCP + UDP | TURN |
| 5349 | TCP + UDP | TURNS (TLS) |
| 49152–65535 | UDP | TURN relay traffic |

---

## Step 1 — System prep and firewall

```bash
apt update && apt upgrade -y

# Install UFW if not present
apt install -y ufw

# Allow SSH so you don't lock yourself out
ufw allow 22/tcp

# Web + WebSocket
ufw allow 80/tcp
ufw allow 443/tcp

# TURN
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 5349/tcp
ufw allow 5349/udp
ufw allow 49152:65535/udp

ufw enable
```

---

## Step 2 — Download and install Iskra server

```bash
# Create a directory for the server
mkdir -p /opt/iskra
cd /opt/iskra

# Download the latest server release
wget https://github.com/quikmn/iskra-voice/releases/latest/download/Iskra-Server.zip
apt install -y unzip
unzip Iskra-Server.zip
chmod +x iskra_server
```

---

## Step 3 — Configure the server

Create your server config. Replace the values in angle brackets:

```bash
cat > /opt/iskra/iskra_config.json << 'EOF'
{
  "Settings": {
    "ServerName": "My Iskra Server",
    "Port": 8080,
    "AdminPassword": "<choose-a-strong-admin-password>",
    "ServerPassword": "",
    "RequirePassword": false,
    "AuthMode": "open",
    "HistoryRetentionDays": 60,
    "MaxUploadMb": 500,
    "TurnUrls": [
      "turn:<your-domain>:3478",
      "turns:<your-domain>:5349"
    ],
    "TurnUsername": "iskra",
    "TurnCredential": "<choose-a-strong-turn-password>"
  },
  "Channels": [
    { "Id": "general", "Name": "general", "Type": "Text" },
    { "Id": "voice",   "Name": "voice",   "Type": "Voice" }
  ]
}
EOF
```

> **Remember your `TurnCredential`** — you'll use it again in Step 9.

---

## Step 4 — Run Iskra as a systemd service

```bash
cat > /etc/systemd/system/iskra.service << 'EOF'
[Unit]
Description=Iskra Voice Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/iskra
ExecStart=/opt/iskra/iskra_server
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable iskra
systemctl start iskra

# Verify it's running
systemctl status iskra
```

---

## Step 5 — Install nginx and certbot

```bash
apt install -y nginx certbot python3-certbot-nginx
```

---

## Step 6 — Get an SSL certificate

Replace `<your-domain>` and `<your-email>`:

```bash
certbot --nginx -d <your-domain> --email <your-email> --agree-tos --non-interactive
```

Certbot will auto-renew. Verify renewal works:

```bash
certbot renew --dry-run
```

---

## Step 7 — Configure nginx

This proxies HTTPS/WSS traffic to the Iskra server on port 8080:

```bash
cat > /etc/nginx/sites-available/iskra << 'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name <your-domain>;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name <your-domain>;

    ssl_certificate     /etc/letsencrypt/live/<your-domain>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<your-domain>/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF

# Enable the site
ln -s /etc/nginx/sites-available/iskra /etc/nginx/sites-enabled/iskra

# Remove the default site if present
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx
```

---

## Step 8 — Install coturn

```bash
apt install -y coturn

# Enable coturn to start on boot
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

---

## Step 9 — Configure coturn

Replace `<your-domain>` and `<your-turn-password>` (same password you used for `TurnCredential` in Step 3):

```bash
cat > /etc/turnserver.conf << 'EOF'
# Network
listening-port=3478
tls-listening-port=5349
min-port=49152
max-port=65535

# TLS certificates (reuse the ones certbot got for nginx)
cert=/etc/letsencrypt/live/<your-domain>/fullchain.pem
pkey=/etc/letsencrypt/live/<your-domain>/privkey.pem

# Auth — long-term credentials
lt-cred-mech
realm=<your-domain>
user=iskra:<your-turn-password>

# Limits
total-quota=100
no-multicast-peers
fingerprint
EOF

# Allow coturn to read the Let's Encrypt certs
usermod -aG ssl-cert turnserver 2>/dev/null || true
chmod 640 /etc/letsencrypt/live/<your-domain>/privkey.pem
chmod 640 /etc/letsencrypt/archive/<your-domain>/privkey*.pem

systemctl enable coturn
systemctl restart coturn

# Verify
systemctl status coturn
```

---

## Step 10 — Verify everything is running

```bash
systemctl status iskra    # should show: active (running)
systemctl status nginx    # should show: active (running)
systemctl status coturn   # should show: active (running)
```

Check open ports:

```bash
ss -tlnp | grep -E '8080|443|3478|5349'
```

---

## Step 11 — Connect

In Iskra (desktop, web, or Android):

- **Host:** `<your-domain>`
- **Port:** `443`
- **Server password:** leave blank (unless you set `ServerPassword`)
- **Admin password:** the `AdminPassword` you set in Step 3

Voice should work for everyone including friends on mobile data or behind CGNAT — coturn will relay audio when a direct peer-to-peer connection isn't possible.

---

## Updating the server

When a new Iskra server version is released:

```bash
cd /opt/iskra
wget -O Iskra-Server-new.zip https://github.com/quikmn/iskra-voice/releases/latest/download/Iskra-Server.zip
unzip -o Iskra-Server-new.zip
chmod +x iskra_server
systemctl restart iskra
```

Your config, chat history, and uploads are untouched — they're in separate files.

---

## Certificate renewal + coturn

Let's Encrypt certs renew every 90 days. Coturn needs to be restarted after renewal to pick up the new cert. Add a deploy hook:

```bash
cat > /etc/letsencrypt/renewal-hooks/deploy/restart-coturn.sh << 'EOF'
#!/bin/bash
systemctl restart coturn
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/restart-coturn.sh
```

---

## Troubleshooting

**Server shows offline in the client**
- Confirm nginx is running: `systemctl status nginx`
- Confirm Iskra is running on 8080: `ss -tlnp | grep 8080`
- Check logs: `journalctl -u iskra -n 50`

**Voice works locally but not for friends on mobile data**
- Confirm coturn is running: `systemctl status coturn`
- Confirm ports 3478 and 49152–65535/udp are open in your firewall
- Check coturn logs: `journalctl -u coturn -n 50`
- Double-check the `TurnCredential` in `iskra_config.json` matches the `user=iskra:` line in `turnserver.conf`

**SSL certificate errors**
- Run `certbot renew` and check output
- Confirm your domain DNS A record points to this server's IP
