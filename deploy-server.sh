#!/bin/bash
# Deploy iskra_server to a Linux Ubuntu host.
# Usage: bash deploy-server.sh [--world <folder-name>]
# Requires: ssh key auth to root@REMOTE_IP
#           rsync installed locally (git bash / wsl / linux)

set -e

REMOTE_IP="146.190.226.221"
REMOTE="root@$REMOTE_IP"
APP_DIR="/opt/iskra-server"
SVC="iskra-server"
WORLD="${WORLD:-quikmn-main}"
PUBLISH_DIR="$(dirname "$0")/iskra_server/publish-linux"

# ── parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --world) WORLD="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

WORLD_DIR="$(dirname "$0")/servers/$WORLD"

if [[ ! -f "$WORLD_DIR/server.json" ]]; then
    echo "ERROR: No server.json found at $WORLD_DIR"
    exit 1
fi

# ── sanity check password ─────────────────────────────────────────────────────
if grep -q '"ServerPassword": "change_me"' "$WORLD_DIR/server.json"; then
    echo ""
    echo "WARNING: server.json still has ServerPassword = \"change_me\""
    echo "  Edit servers/$WORLD/server.json and set a real password first."
    read -p "  Continue anyway? [y/N] " CONT
    [[ "$CONT" =~ ^[Yy]$ ]] || exit 1
fi

# ── build: self-contained linux-x64 binary ────────────────────────────────────
echo ""
echo "==> Publishing iskra_server for linux-x64..."
dotnet publish "$(dirname "$0")/iskra_server/iskra_server.csproj" \
    -c Release \
    -r linux-x64 \
    --self-contained true \
    -p:PublishSingleFile=true \
    -p:DebugType=none \
    -o "$PUBLISH_DIR" \
    --nologo 2>&1 | grep -E '^.*(error|Error|FAILED|succeeded)' || true

echo "--> Build done: $PUBLISH_DIR"

# ── provision server ──────────────────────────────────────────────────────────
echo ""
echo "==> Provisioning $REMOTE..."
ssh "$REMOTE" bash << 'ENDSSH'
set -e
apt-get update -qq
apt-get install -y ufw rsync

# open port 8080
ufw allow 8080/tcp
ufw --force enable
echo "--> ufw: port 8080 open"

mkdir -p /opt/iskra-server
ENDSSH

# ── upload binary ─────────────────────────────────────────────────────────────
echo ""
echo "==> Uploading server binary..."
rsync -az --delete "$PUBLISH_DIR/" "$REMOTE:$APP_DIR/app/"
ssh "$REMOTE" "chmod +x $APP_DIR/app/iskra_server"

# ── upload world folder ───────────────────────────────────────────────────────
echo ""
echo "==> Uploading world: $WORLD"
ssh "$REMOTE" "mkdir -p $APP_DIR/servers/$WORLD"
# sync world but preserve remote data files (fingerprints, bans, chat logs)
rsync -az \
    --exclude 'fingerprints.json' \
    --exclude 'bans.json' \
    --exclude 'audit.jsonl' \
    "$WORLD_DIR/" "$REMOTE:$APP_DIR/servers/$WORLD/"

echo "--> World uploaded (fingerprints/bans/audit preserved if they existed)"

# ── fix ServerIcon URL in remote server.json ──────────────────────────────────
echo ""
echo "==> Patching ServerIcon URL in remote server.json..."
ssh "$REMOTE" "sed -i 's|http://localhost:[0-9]*/uploads/|http://$REMOTE_IP:8080/uploads/|g' $APP_DIR/servers/$WORLD/server.json"
echo "--> ServerIcon updated to http://$REMOTE_IP:8080/..."

# ── systemd service ───────────────────────────────────────────────────────────
echo ""
echo "==> Installing systemd service..."
ssh "$REMOTE" bash << ENDSSH2
cat > /etc/systemd/system/$SVC.service << ENDSVC
[Unit]
Description=Iskra Voice Chat Server ($WORLD)
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/app/iskra_server $APP_DIR/servers/$WORLD
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SVC

[Install]
WantedBy=multi-user.target
ENDSVC

systemctl daemon-reload
systemctl enable $SVC
systemctl restart $SVC
sleep 1
systemctl status $SVC --no-pager -l
ENDSSH2

echo ""
echo "==> Done!"
echo "    WebSocket: ws://$REMOTE_IP:8080"
echo "    Logs:      ssh $REMOTE journalctl -u $SVC -f"
echo ""
echo "    Next steps:"
echo "    1. Make sure the server password in server.json is set (not 'change_me')"
echo "    2. Add this server in the Iskra client: ws://$REMOTE_IP:8080"
echo "    3. Check TURN is reachable from the new host (turn01.ams.iskra.foo)"
