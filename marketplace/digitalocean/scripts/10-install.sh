#!/bin/bash
# Builds the Iskra image: runs once, as root, in the temporary build droplet (Packer, iskra.pkr.hcl).
# Installs the server, its services and the first-boot script, and turns on the firewall and security updates.
# The image carries no world folder, keys or certificates: each droplet makes its own on first boot.
set -euo pipefail
: "${ISKRA_VERSION:?ISKRA_VERSION is required}"

SRC=/tmp/iskra
FILES="$SRC/files"
PACKAGE="iskra-server-${ISKRA_VERSION}-linux-x64.tar.gz"
export DEBIAN_FRONTEND=noninteractive

# Up to date (DigitalOcean's image check refuses pending security updates), plus what Iskra and the screens use.
apt-get -q update
apt-get -qy -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade
apt-get -qy install curl ca-certificates tar ufw iproute2 unattended-upgrades

# The server, checked against the release's checksums once more (build.sh checked them and the build attestation).
grep -E "^[0-9a-f]{64} [ *]${PACKAGE}\$" "$SRC/SHA256SUMS.txt" > "$SRC/expected"
(cd "$SRC" && sha256sum -c expected)

id iskra >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/iskra --shell /usr/sbin/nologin iskra
tar -xzf "$SRC/$PACKAGE" -C /opt/iskra
for f in iskra-server livekit-server iskra-update-guard; do
  [ -x "/opt/iskra/$f" ] || { echo "The package has no $f"; exit 1; }
done
chown -R iskra:iskra /opt/iskra
# The server runs on this machine (and says the version we asked for).
(cd /opt/iskra && runuser -u iskra -- env HOME=/opt/iskra /opt/iskra/iskra-server version) | grep -F "$ISKRA_VERSION"

# Services, the claim screen and the first-boot script. Root-owned, outside /opt/iskra (which the server's user
# owns and updates), because root runs them.
install -m 644 "$FILES/etc/systemd/system/iskra.service" /etc/systemd/system/iskra.service
install -m 644 "$FILES/etc/systemd/system/iskra-claim-screen.service" /etc/systemd/system/iskra-claim-screen.service
install -m 644 "$FILES/etc/systemd/system/iskra-claim-screen.timer" /etc/systemd/system/iskra-claim-screen.timer
install -m 755 "$FILES/usr/local/sbin/iskra-claim-screen" /usr/local/sbin/iskra-claim-screen
install -m 755 "$FILES/etc/update-motd.d/99-iskra" /etc/update-motd.d/99-iskra
install -d -m 755 /var/lib/cloud/scripts/per-instance
install -m 755 "$FILES/var/lib/cloud/scripts/per-instance/10-iskra-world" /var/lib/cloud/scripts/per-instance/10-iskra-world
install -d -m 755 /etc/iskra
cp /etc/issue /etc/iskra/issue.original
systemctl daemon-reload
# Started by the first-boot script, after it has written this droplet's own server.json.
systemctl disable iskra.service iskra-claim-screen.timer >/dev/null 2>&1 || true

# Only what Iskra needs: SSH (DigitalOcean's console uses it), web (80 for the certificate, 443) and voice.
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 7882/udp
ufw --force enable

# Security updates install themselves (Iskra updates itself too: Updates.Mode "auto").
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
systemctl enable unattended-upgrades >/dev/null 2>&1 || true

# DigitalOcean's agent comes with the build droplet; its image check refuses images that carry it (/opt/digitalocean).
# Every droplet made from the image gets it again from DigitalOcean.
apt-get -y purge droplet-agent >/dev/null 2>&1 || true
rm -rf /opt/digitalocean

# Nothing of a server in the image.
if [ -e /opt/iskra/world ]; then echo "The image must not have a world folder"; exit 1; fi
rm -rf "$SRC"
echo "Iskra $ISKRA_VERSION installed."
