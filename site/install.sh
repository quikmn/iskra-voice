#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  WARNING: ISKRA v1 LEGACY SCRIPT. NOT SUPPORTED.
#
#  This script installs Iskra v1, which is retired. v1 has known security
#  issues and its hosted services (Iskra ID / account.iskra.foo, the relay,
#  app.iskra.foo, the public TURN server, server discovery) are offline.
#  Please don't use it for new servers. It is kept for reference only.
#
#  Note: it downloads from github.com/quikmn/iskra, which no longer exists
#  (the repo is now github.com/quikmn/iskra-voice), so step 4 will fail.
#
#  Iskra 2 is being rebuilt from the ground up:
#  https://github.com/quikmn/iskra-voice
# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
#  Iskra Server — Automated Setup Script
#  https://iskra.foo/install.sh
#
#  What this does:
#    1. Updates the system
#    2. Installs nginx, certbot, dotnet-runtime-8.0, coturn
#    3. Configures the firewall (ufw)
#    4. Downloads the latest Iskra server from GitHub
#    5. Writes server.json with your settings
#    6. Configures coturn (TURN relay for voice)
#    7. Configures nginx (reverse proxy + SSL)
#    8. Gets your SSL certificate (Let's Encrypt)
#    9. Installs Iskra as a systemd service
#   10. Enables automatic certificate renewal
#
#  Requirements: Ubuntu 22.04, running as root, domain already pointing at VPS
#
#  Usage:
#    curl -fsSL https://iskra.foo/install.sh | bash
#    — or —
#    curl -fsSL https://iskra.foo/install.sh -o install.sh && bash install.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
PURPLE='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
step()    { echo -e "\n${PURPLE}${BOLD}[${1}/${TOTAL_STEPS}]${NC} ${BOLD}${2}${NC}"; }
ok()      { echo -e "  ${GREEN}✓${NC} ${1}"; }
info()    { echo -e "  ${CYAN}→${NC} ${1}"; }
warn()    { echo -e "  ${YELLOW}⚠${NC}  ${1}"; }
die()     { echo -e "\n${RED}${BOLD}✗ Error:${NC} ${1}\n"; exit 1; }

TOTAL_STEPS=10

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo -e "${PURPLE}${BOLD}"
echo "  ╦╔═╗╦╔═╦═╗╔═╗"
echo "  ║╚═╗╠╩╗╠╦╝╠═╣"
echo "  ╩╚═╝╩ ╩╩╚═╩ ╩  Server Setup"
echo -e "${NC}"
echo -e "  ${DIM}https://iskra.foo${NC}"
echo -e "  ${DIM}Open-source self-hosted voice chat${NC}"
echo ""
echo -e "  This script will set up a complete Iskra server on this machine."
echo -e "  It installs nginx, coturn, and Iskra, then wires everything together."
echo ""
echo -e "  ${DIM}Takes about 5–10 minutes. Sit back.${NC}"
echo ""

# ── Root check ────────────────────────────────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  die "Please run as root: sudo bash install.sh"
fi

# ── Ubuntu check ──────────────────────────────────────────────────────────────
if ! grep -q 'Ubuntu' /etc/os-release 2>/dev/null; then
  warn "This script was tested on Ubuntu 22.04. Other distros may need adjustments."
  read -rp "  Continue anyway? [y/N] " _cont
  [[ "$_cont" =~ ^[Yy]$ ]] || exit 0
fi

# ── Collect inputs ────────────────────────────────────────────────────────────
echo -e "${BOLD}  Answer a few questions, then we'll handle the rest.${NC}"
echo ""

# Domain
while true; do
  read -rp "  $(echo -e "${CYAN}Your domain${NC} (e.g. chat.myfriends.com): ")" DOMAIN
  DOMAIN="${DOMAIN// /}"
  [[ -n "$DOMAIN" ]] && break
  warn "Domain cannot be empty."
done

# Email for Let's Encrypt
while true; do
  read -rp "  $(echo -e "${CYAN}Your email${NC} (for SSL certificate renewal notices): ")" EMAIL
  EMAIL="${EMAIL// /}"
  [[ "$EMAIL" == *@* ]] && break
  warn "Please enter a valid email address."
done

# TURN password
echo ""
echo -e "  ${DIM}The TURN password is used internally between Iskra and coturn."
echo -e "  Pick something random — your friends never see or type this.${NC}"
while true; do
  read -rp "  $(echo -e "${CYAN}TURN password${NC} (make something up, e.g. waffles99thunder): ")" TURN_PASSWORD
  [[ "${#TURN_PASSWORD}" -ge 8 ]] && break
  warn "Password must be at least 8 characters."
done

# Server name
read -rp "  $(echo -e "${CYAN}Server name${NC} (shown in the app, e.g. The Crew): ")" SERVER_NAME
SERVER_NAME="${SERVER_NAME:-Iskra Server}"

echo ""
echo -e "  ${DIM}──────────────────────────────────────────${NC}"
echo -e "  Domain:       ${BOLD}${DOMAIN}${NC}"
echo -e "  Email:        ${BOLD}${EMAIL}${NC}"
echo -e "  Server name:  ${BOLD}${SERVER_NAME}${NC}"
echo -e "  TURN user:    ${BOLD}iskra${NC} / ${BOLD}${TURN_PASSWORD}${NC}"
echo -e "  ${DIM}──────────────────────────────────────────${NC}"
echo ""
read -rp "  $(echo -e "${BOLD}Looks good? Start the install? [Y/n]${NC} ")" _go
[[ "$_go" =~ ^[Nn]$ ]] && { echo "Aborted."; exit 0; }

echo ""

# ── Step 1: Update system ─────────────────────────────────────────────────────
step 1 "Updating system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
ok "System up to date"

# ── Step 2: Add .NET repo and install dependencies ────────────────────────────
step 2 "Installing nginx, certbot, .NET 8, coturn"

# Add Microsoft package repo if dotnet isn't already available
if ! apt-cache show dotnet-runtime-8.0 &>/dev/null; then
  info "Adding Microsoft package repository..."
  wget -q https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb \
       -O /tmp/packages-microsoft-prod.deb
  dpkg -i /tmp/packages-microsoft-prod.deb
  rm /tmp/packages-microsoft-prod.deb
  apt-get update -qq
fi

apt-get install -y -qq nginx certbot python3-certbot-nginx dotnet-runtime-8.0 coturn unzip curl
ok "nginx, certbot, dotnet-runtime-8.0, coturn installed"

# ── Step 3: Firewall ──────────────────────────────────────────────────────────
step 3 "Configuring firewall (ufw)"

ufw allow 22/tcp    &>/dev/null
ufw allow 80/tcp    &>/dev/null
ufw allow 443/tcp   &>/dev/null
ufw allow 8080/tcp  &>/dev/null
ufw allow 3478/udp  &>/dev/null
ufw allow 5349/tcp  &>/dev/null
ufw allow 49152:65535/udp &>/dev/null
ufw --force enable  &>/dev/null

ok "Firewall enabled: 22, 80, 443, 8080, 3478, 5349, 49152–65535"

# ── Step 4: Download Iskra server ─────────────────────────────────────────────
step 4 "Downloading Iskra server"

mkdir -p /opt/iskra
cd /opt/iskra

info "Fetching latest release from GitHub..."
RELEASE_URL=$(curl -s https://api.github.com/repos/quikmn/iskra/releases/latest \
  | grep "browser_download_url" \
  | grep -i "Iskra-Server.zip" \
  | cut -d '"' -f 4)

if [[ -z "$RELEASE_URL" ]]; then
  die "Could not find Iskra-Server.zip in the latest GitHub release.\nCheck https://github.com/quikmn/iskra/releases and download manually."
fi

info "Downloading from: ${DIM}${RELEASE_URL}${NC}"
wget -q --show-progress -O /opt/iskra/Iskra-Server.zip "$RELEASE_URL"
unzip -q -o /opt/iskra/Iskra-Server.zip -d /opt/iskra/
rm /opt/iskra/Iskra-Server.zip

# Find the .dll file
DLL_FILE=$(find /opt/iskra -maxdepth 2 -name "*.dll" | grep -i "iskra_server\|iskra-server" | head -1)
if [[ -z "$DLL_FILE" ]]; then
  # Fallback: any .dll that isn't a library
  DLL_FILE=$(find /opt/iskra -maxdepth 2 -name "iskra_server.dll" -o -name "IskaServer.dll" 2>/dev/null | head -1)
fi
if [[ -z "$DLL_FILE" ]]; then
  warn "Could not auto-detect the server .dll file. Files in /opt/iskra:"
  ls /opt/iskra
  read -rp "  Enter the .dll filename (just the name, not the path): " DLL_NAME
  DLL_FILE="/opt/iskra/${DLL_NAME}"
fi

ok "Iskra server downloaded: ${DIM}${DLL_FILE}${NC}"

# ── Step 5: server.json ───────────────────────────────────────────────────────
step 5 "Writing server.json"

cat > /opt/iskra/server.json << EOF
{
  "ServerName":            "${SERVER_NAME}",
  "Port":                  8080,
  "MaxUsers":              50,
  "HistoryRetentionDays":  30,
  "TurnUrls":              ["turn:${DOMAIN}:3478", "turns:${DOMAIN}:5349"],
  "TurnUsername":          "iskra",
  "TurnCredential":        "${TURN_PASSWORD}"
}
EOF

ok "server.json written"

# ── Step 6: coturn ────────────────────────────────────────────────────────────
step 6 "Configuring coturn (TURN relay)"

cat > /etc/turnserver.conf << EOF
listening-port=3478
tls-listening-port=5349
realm=${DOMAIN}
user=iskra:${TURN_PASSWORD}
lt-cred-mech
fingerprint
min-port=49152
max-port=65535
EOF

# Enable coturn daemon
if grep -q '#TURNSERVER_ENABLED' /etc/default/coturn; then
  sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
else
  echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
fi

systemctl enable coturn &>/dev/null
systemctl restart coturn

if systemctl is-active --quiet coturn; then
  ok "coturn running"
else
  warn "coturn failed to start. Check: journalctl -u coturn -n 20"
fi

# ── Step 7: nginx ─────────────────────────────────────────────────────────────
step 7 "Configuring nginx reverse proxy"

cat > /etc/nginx/sites-available/iskra << EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 86400;
    }
}
EOF

ln -sf /etc/nginx/sites-available/iskra /etc/nginx/sites-enabled/iskra
rm -f /etc/nginx/sites-enabled/default

nginx -t &>/dev/null || die "nginx config test failed. Run: nginx -t"
systemctl reload nginx
ok "nginx configured and reloaded"

# ── Step 8: SSL certificate ───────────────────────────────────────────────────
step 8 "Getting SSL certificate (Let's Encrypt)"

info "Checking DNS — ${DOMAIN} should resolve to this machine..."
RESOLVED_IP=$(dig +short "$DOMAIN" 2>/dev/null | tail -1)
MY_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || curl -s --max-time 5 http://ifconfig.me 2>/dev/null || echo "unknown")

if [[ "$RESOLVED_IP" != "$MY_IP" && "$MY_IP" != "unknown" ]]; then
  warn "${DOMAIN} resolves to ${RESOLVED_IP:-'(nothing)'}, but this machine's IP is ${MY_IP}."
  warn "certbot may fail if DNS hasn't propagated yet."
  read -rp "  Try anyway? [Y/n] " _cert_go
  [[ "$_cert_go" =~ ^[Nn]$ ]] && {
    warn "Skipping SSL for now. Run this later:"
    echo -e "    certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m ${EMAIL}"
    SSL_SKIPPED=true
  }
fi

if [[ "${SSL_SKIPPED:-false}" != "true" ]]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" \
    --redirect 2>&1 | grep -E "Congratulations|error|Error|failed|Failed" || true

  if certbot certificates 2>/dev/null | grep -q "$DOMAIN"; then
    ok "SSL certificate issued for ${DOMAIN}"
    # Enable auto-renewal timer
    systemctl enable certbot.timer &>/dev/null
    systemctl start certbot.timer &>/dev/null
    ok "Auto-renewal enabled (certbot.timer)"
  else
    warn "SSL certificate may not have been issued. Check: certbot certificates"
  fi
fi

# ── Step 9: systemd service ───────────────────────────────────────────────────
step 9 "Installing Iskra as a system service"

cat > /etc/systemd/system/iskra.service << EOF
[Unit]
Description=Iskra Voice Chat Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/iskra
ExecStart=/usr/bin/dotnet ${DLL_FILE}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable iskra &>/dev/null
systemctl restart iskra

sleep 2

if systemctl is-active --quiet iskra; then
  ok "Iskra service running"
else
  warn "Iskra service may not have started correctly."
  warn "Check: journalctl -u iskra -n 30"
fi

# ── Step 10: Reload nginx with final SSL config ───────────────────────────────
step 10 "Final checks"

systemctl reload nginx &>/dev/null || true

# Quick connectivity check
info "Waiting 3 seconds for Iskra to fully start..."
sleep 3

if curl -s --max-time 5 http://localhost:8080 &>/dev/null; then
  ok "Iskra is responding on localhost:8080"
else
  warn "Iskra didn't respond on localhost:8080 within 5 seconds — may still be starting up."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ✓ Setup complete!${NC}"
echo ""
echo -e "  ${DIM}──────────────────────────────────────────────────────${NC}"
echo -e "  ${BOLD}Your Iskra server is running.${NC}"
echo ""
echo -e "  ${CYAN}Connect from the Iskra app:${NC}"
echo -e "    Address:   ${BOLD}${DOMAIN}${NC}"
echo -e "    Web port:  ${BOLD}443${NC}"
echo ""
echo -e "  ${CYAN}Download the client:${NC}"
echo -e "    ${BOLD}https://iskra.foo${NC}"
echo ""
echo -e "  ${CYAN}Useful commands:${NC}"
echo -e "    ${DIM}systemctl status iskra${NC}        — check if Iskra is running"
echo -e "    ${DIM}systemctl restart iskra${NC}       — restart after changes"
echo -e "    ${DIM}journalctl -u iskra -f${NC}        — watch live logs"
echo -e "    ${DIM}systemctl status coturn${NC}       — check TURN relay"
echo -e "    ${DIM}cat /opt/iskra/server.json${NC}    — view your config"
echo ""
if [[ "${SSL_SKIPPED:-false}" == "true" ]]; then
  echo -e "  ${YELLOW}⚠  SSL was skipped. Once DNS propagates, run:${NC}"
  echo -e "    certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m ${EMAIL}"
  echo ""
fi
echo -e "  ${DIM}──────────────────────────────────────────────────────${NC}"
echo -e "  ${DIM}Having trouble? Read the full guide: https://iskra.foo/setup.html${NC}"
echo -e "  ${DIM}Or ask an AI — paste the error into ChatGPT, Gemini, or Claude.${NC}"
echo ""
