# TLS / WSS Setup for Web Client Access

The Iskra web client (`app.iskra.foo`) is served over HTTPS and connects
to Iskra servers using `wss://` (WebSocket Secure). Plain `ws://` connections
are blocked by browsers when the page is on HTTPS (mixed content policy).

**Server admins must terminate TLS in front of their Iskra server** to allow
web client connections.

---

## Recommended: nginx reverse proxy

This proxies `wss://yourserver.example.com` → `ws://localhost:8080`.
Works on any Linux VPS. Requires a domain + certbot.

### 1. Install nginx + certbot

```bash
apt install nginx certbot python3-certbot-nginx
```

### 2. nginx config

`/etc/nginx/sites-available/iskra`

```nginx
server {
    listen 80;
    server_name yourserver.example.com;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 3600s;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:8080/uploads/;
        add_header Access-Control-Allow-Origin *;
        expires 1d;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/iskra /etc/nginx/sites-enabled/iskra
nginx -t && systemctl reload nginx
```

### 3. SSL certificate

```bash
certbot --nginx -d yourserver.example.com --non-interactive --agree-tos -m you@example.com
```

nginx now listens on 443 with TLS. Certbot auto-renews.

### 4. Add the server in Iskra

In Settings → Servers, add:
- **Host:** `yourserver.example.com`
- **Port:** `443`

The web client will connect via `wss://yourserver.example.com:443` automatically.

---

## Native client (Windows app)

The native Windows client always uses plain `ws://` and is unaffected by
this requirement. Native client users connect directly to the server IP/port
as before — no proxy needed.

---

## Cloudflare Tunnel (alternative, no domain required)

Cloudflare Tunnel can expose your local Iskra server via `wss://` without
opening ports or buying a domain:

```bash
cloudflared tunnel --url http://localhost:8080
```

This gives you a `*.trycloudflare.com` URL that works with the web client.
Useful for testing; not recommended for permanent deployments.
