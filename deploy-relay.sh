#!/bin/bash
# Deploy iskra_relay to id.iskra.foo (159.65.197.109)
# Run this from your local machine: bash deploy-relay.sh
# Requires: ssh key auth to root@159.65.197.109

set -e

REMOTE="root@159.65.197.109"
APP_DIR="/opt/iskra-relay"
SVC="iskra-relay"
DOMAIN="id.iskra.foo"

echo "==> Building iskra_relay locally..."
cd "$(dirname "$0")/iskra_relay"
dotnet publish -c Release -r linux-x64 --self-contained false -o ./publish
cd ..

echo "==> Copying build to server..."
ssh "$REMOTE" "mkdir -p $APP_DIR/app && rm -rf $APP_DIR/app/*"
scp -r iskra_relay/publish/. "$REMOTE:$APP_DIR/app/"

echo "==> Provisioning server..."
ssh "$REMOTE" bash << 'ENDSSH'
set -e

# ── .NET 8 SDK ────────────────────────────────────────────────────────────────
if ! command -v dotnet &>/dev/null; then
    echo "--> Installing .NET 8 SDK..."
    wget -q https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb -O /tmp/packages-microsoft-prod.deb
    dpkg -i /tmp/packages-microsoft-prod.deb
    apt-get update -qq
    apt-get install -y dotnet-sdk-8.0
else
    echo "--> .NET already installed: $(dotnet --version)"
fi

# ── nginx + certbot ───────────────────────────────────────────────────────────
apt-get install -y nginx certbot python3-certbot-nginx

# ── nginx config ──────────────────────────────────────────────────────────────
cat > /etc/nginx/sites-available/iskra-relay << 'NGINX'
server {
    listen 80;
    server_name id.iskra.foo;

    location / {
        proxy_pass         http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection keep-alive;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 4m;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/iskra-relay /etc/nginx/sites-enabled/iskra-relay
nginx -t && systemctl reload nginx

ENDSSH

# ── relay.json ────────────────────────────────────────────────────────────────
if ! ssh "$REMOTE" "test -f $APP_DIR/relay.json"; then
    echo ""
    echo "==> relay.json not found on server. Enter config:"
    read -p "  Resend API key: " RESEND_KEY
    read -p "  From email [noreply@iskra.foo]: " FROM_EMAIL
    FROM_EMAIL="${FROM_EMAIL:-noreply@iskra.foo}"

    ssh "$REMOTE" "cat > $APP_DIR/relay.json" << ENDJSON
{
  "DbPath": "$APP_DIR/iskra_relay.db",
  "Port": 5000,
  "BaseUrl": "https://$DOMAIN",
  "ResendApiKey": "$RESEND_KEY",
  "FromEmail": "$FROM_EMAIL"
}
ENDJSON
    echo "--> relay.json written"
else
    echo "--> relay.json already exists, skipping"
fi

# ── systemd service ───────────────────────────────────────────────────────────
ssh "$REMOTE" bash << ENDSSH2
cat > /etc/systemd/system/$SVC.service << ENDSVC
[Unit]
Description=Iskra Relay Identity Service
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/dotnet $APP_DIR/app/iskra_relay.dll
Restart=always
RestartSec=5
Environment=DOTNET_ENVIRONMENT=Production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SVC

[Install]
WantedBy=multi-user.target
ENDSVC

systemctl daemon-reload
systemctl enable $SVC
systemctl restart $SVC
echo "--> Service status:"
systemctl status $SVC --no-pager -l
ENDSSH2

# ── SSL ───────────────────────────────────────────────────────────────────────
# Always re-apply certbot after deploy so the nginx config includes the SSL block
# (the deploy step overwrites nginx config with a plain port-80 version)
echo "==> Applying SSL certificate for $DOMAIN..."
ssh "$REMOTE" "certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m viktor.lundgren@gmail.com 2>&1 | tail -5"
echo "--> SSL configured"

echo ""
echo "==> Done! Relay should be live at https://$DOMAIN/health"
