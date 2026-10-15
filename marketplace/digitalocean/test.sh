#!/bin/bash
# Tests a built image end to end, as a user would meet it: a $6 droplet from the snapshot, HTTPS on its sslip.io name,
# the claim screen, ufw, then a claim with the app's own code (client/interop/claim.test.ts: new identity, address +
# code, joined as the owner, a voice token and a LiveKit room), and the console back to normal. See README.md.
#   DIGITALOCEAN_TOKEN=... ./test.sh <snapshot-id> [region]    (region: the snapshot's, default nyc3; build.sh prints both)
#   DIGITALOCEAN_TOKEN=... ./test.sh --sweep                   deletes leftover test and build droplets and test SSH keys
# The droplet and its temporary SSH key are always deleted again (about 10 minutes of a $6 droplet); the snapshot stays.
# Needs curl, jq, ssh, ssh-keygen and Node, with `npm ci` done in client/ and bots/. Never prints the claim code.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
api=https://api.digitalocean.com/v2
tag=iskra-image-test
build_tag=iskra-image-build # Packer's build droplet (iskra.pkr.hcl), if a cancelled build left it behind
size=s-1vcpu-1gb

[ -n "${DIGITALOCEAN_TOKEN:-}" ] || { echo "Set DIGITALOCEAN_TOKEN (README.md, step 2)" >&2; exit 1; }
need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
  done
}
need curl jq

# do_api METHOD PATH [curl arguments]: DigitalOcean's API; on an error its message goes to stderr.
do_api() {
  local method="$1" path="$2" out
  shift 2
  if ! out="$(curl -sS --fail-with-body --proto '=https' --tlsv1.2 --max-time 60 -X "$method" \
    -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" -H 'Content-Type: application/json' "$@" "$api$path")"; then
    echo "DigitalOcean API: $method $path failed: $out" >&2
    return 1
  fi
  printf '%s' "$out"
}

sweep() {
  local t keys k
  for t in "$tag" "$build_tag"; do
    do_api DELETE "/droplets?tag_name=$t" >/dev/null && echo "Deleted any droplets tagged $t."
  done
  keys="$(do_api GET '/account/keys?per_page=200' | jq -r --arg p "$tag-" '.ssh_keys[] | select(.name | startswith($p)) | .id')"
  for k in $keys; do
    do_api DELETE "/account/keys/$k" >/dev/null && echo "Deleted SSH key $k."
  done
  return 0
}

if [ "${1:-}" = "--sweep" ]; then
  sweep
  exit 0
fi

need ssh ssh-keygen node npx
snapshot="${1:-}"
region="${2:-nyc3}"
[[ "$snapshot" =~ ^[0-9]+$ ]] || { echo "Usage: $0 <snapshot-id> [region]" >&2; exit 1; }
[[ "$region" =~ ^[a-z0-9]+$ ]] || { echo "Not a region: $region" >&2; exit 1; }

mask() { if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "$1" ]; then echo "::add-mask::$1"; fi; }
fail() { echo "FAIL: $*" >&2; exit 1; }

work="$(mktemp -d)"
name=""
droplet_id=""
key_id=""
ip=""
ssh_do() {
  ssh -i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$work/known_hosts" \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o LogLevel=ERROR "root@$ip" "$@"
}

cleanup() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ] && [ -n "$ip" ] && [ -s "$work/key" ]; then
    echo "--- Droplet diagnostics ---"
    ssh_do 'cloud-init status; systemctl --no-pager status iskra | head -n 5; tail -n 30 /var/log/iskra-setup.log; journalctl -u iskra --no-pager -n 40'
  fi
  if [ -n "$droplet_id" ]; then
    do_api DELETE "/droplets/$droplet_id" >/dev/null && echo "Deleted droplet $droplet_id."
  fi
  if [ -n "$key_id" ]; then
    do_api DELETE "/account/keys/$key_id" >/dev/null && echo "Deleted SSH key $key_id."
  fi
  rm -rf "$work"
  if [ "$status" -eq 0 ]; then echo "PASS: snapshot $snapshot${name:+ ($name)}"; else echo "FAIL: snapshot $snapshot${name:+ ($name)}" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The snapshot, in the region we test in.
image="$(do_api GET "/images/$snapshot")"
name="$(jq -r '.image.name' <<<"$image")"
jq -e --arg r "$region" '.image.regions | index($r)' <<<"$image" >/dev/null || fail "snapshot $snapshot isn't in $region"
echo "Testing snapshot $snapshot ($name) in $region."

# A temporary SSH key, only for this test.
ssh-keygen -q -t ed25519 -N '' -C "$tag" -f "$work/key"
key_id="$(do_api POST /account/keys \
  -d "$(jq -n --arg name "$tag-$(date -u +%Y%m%d-%H%M%S)-$$" --arg key "$(cat "$work/key.pub")" '{name: $name, public_key: $key}')" |
  jq -r '.ssh_key.id')"
[[ "$key_id" =~ ^[0-9]+$ ]] || fail "no SSH key ID ($key_id)"

# The droplet, as "Create Iskra Droplet" makes it: the $6 size, nothing but the image (its first boot does the rest).
body="$(jq -n --arg region "$region" --arg size "$size" --argjson image "$snapshot" --argjson key "$key_id" --arg tag "$tag" \
  '{name: "iskra-image-test", region: $region, size: $size, image: $image, ssh_keys: [$key], tags: [$tag],
    ipv6: false, monitoring: false, backups: false}')"
droplet_id="$(do_api POST /droplets -d "$body" | jq -r '.droplet.id')"
[[ "$droplet_id" =~ ^[0-9]+$ ]] || { droplet_id=""; fail "no droplet ID"; }
echo "Droplet $droplet_id created."

for i in $(seq 1 60); do
  droplet="$(do_api GET "/droplets/$droplet_id")"
  if [ "$(jq -r '.droplet.status' <<<"$droplet")" = active ]; then
    ip="$(jq -r '.droplet.networks.v4[] | select(.type == "public") | .ip_address' <<<"$droplet" | head -n 1)"
    [ -n "$ip" ] && break
  fi
  [ "$i" -lt 60 ] || fail "the droplet isn't active after 5 minutes"
  sleep 5
done
[[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "no public IPv4 address ($ip)"
address="https://${ip//./-}.sslip.io"
echo "Droplet $droplet_id is active: $ip, $address"

for i in $(seq 1 60); do
  ssh_do true 2>/dev/null && break
  [ "$i" -lt 60 ] || fail "no SSH after 5 minutes"
  sleep 5
done
echo "SSH is up."

# The claim screen: /root/iskra-claim.txt, the console (/etc/issue) and the login message (/etc/update-motd.d/99-iskra).
for i in $(seq 1 60); do
  ssh_do 'grep -q "Claim code:" /root/iskra-claim.txt' 2>/dev/null && break
  [ "$i" -lt 60 ] || fail "no claim code in /root/iskra-claim.txt after 5 minutes"
  sleep 5
done
screen="$(ssh_do cat /root/iskra-claim.txt)"
code="$(sed -n 's/^ *Claim code: *\([0-9A-Z]\{4\}\(-[0-9A-Z]\{4\}\)\{3\}\) .*/\1/p' <<<"$screen" | head -n 1)"
mask "$code"
mask "${code//-/}"
mask "$(tr '[:upper:]' '[:lower:]' <<<"${code//-/}")"
[ -n "$code" ] || fail "/root/iskra-claim.txt has no well-formed claim code"
grep -qF "Address:     $address" <<<"$screen" || fail "/root/iskra-claim.txt doesn't show $address"
ssh_do "grep -qF 'Claim code:  $code' /etc/issue" || fail "the console (/etc/issue) doesn't show the claim code"
ssh_do "/etc/update-motd.d/99-iskra | grep -qF 'Claim code:  $code'" || fail "the login message doesn't show the claim code"
ssh_do "[ \"\$(stat -c %a /root/iskra-claim.txt)\" = 600 ]" || fail "/root/iskra-claim.txt isn't owner-only"
echo "Claim screen OK (console, login message, /root/iskra-claim.txt)."

# Services and the firewall the image sets up.
ssh_do 'systemctl is-active --quiet iskra' || fail "iskra.service isn't running"
ssh_do 'systemctl is-active --quiet iskra-claim-screen.timer' || fail "the claim screen's timer isn't running"
ufw="$(ssh_do 'ufw status')"
echo "$ufw"
grep -q '^Status: active' <<<"$ufw" || fail "ufw isn't active"
for rule in 22/tcp 80/tcp 443/tcp 7881/tcp 7882/udp; do
  grep -qE "^$rule +ALLOW +Anywhere" <<<"$ufw" || fail "ufw doesn't allow $rule"
done
[ "$(grep -cE ' ALLOW ' <<<"$ufw")" -le 10 ] || fail "ufw allows more than Iskra's ports"

# HTTPS with a real certificate (Let's Encrypt, made by the server), and voice (LiveKit) up.
for i in $(seq 1 72); do
  if health="$(curl -fsS --proto '=https' --max-time 10 "$address/health" 2>/dev/null)" &&
    jq -e '.status == "ok" and .voice == "up"' <<<"$health" >/dev/null; then
    break
  fi
  [ "$i" -lt 72 ] || fail "$address/health isn't OK with voice up after 12 minutes (${health:-no answer})"
  sleep 10
done
echo "HTTPS OK: $health"

# The claim, with the app's own code (a new identity; it never sends the code anywhere).
echo "Claiming $address with the app's claim code path..."
(cd "$here/../../client" && ISKRA_DROPLET_URL="$address" ISKRA_DROPLET_CODE="$code" \
  npx vitest run --config vitest.interop.config.ts interop/claim.test.ts)

# Once claimed, the console goes back to normal and the code is gone (the timer would do this within a minute).
ssh_do 'systemctl start iskra-claim-screen.service'
ssh_do 'cmp -s /etc/issue /etc/iskra/issue.original' || fail "the console (/etc/issue) wasn't restored after the claim"
ssh_do '[ ! -e /root/iskra-claim.txt ] && [ ! -e /opt/iskra/world/owner-claim-code.txt ] && [ ! -e /opt/iskra/world/owner-claim ]' ||
  fail "a claim file is still there after the claim"
ssh_do "! grep -q '\"OwnerClaim\": *\"generate\"' /opt/iskra/world/server.json" || fail "server.json still has OwnerClaim after the claim"
ssh_do '! systemctl is-active --quiet iskra-claim-screen.timer' || fail "the claim screen's timer still runs after the claim"
echo "After the claim: console restored, claim files gone."

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### Image test passed\n\nSnapshot %s (%s, %s): claimed and joined as the owner, voice up. %s\n' \
    "$snapshot" "$name" "$region" "The snapshot is kept; the test droplet and SSH key are deleted." >> "$GITHUB_STEP_SUMMARY"
fi
