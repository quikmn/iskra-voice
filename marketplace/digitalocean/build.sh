#!/bin/bash
# Builds the Iskra 1-Click image (a snapshot) in your DigitalOcean account. See README.md.
#   DIGITALOCEAN_TOKEN=... ./build.sh [version]     (default: the release the app links to, client/src/links.ts)
#   ./build.sh --fetch-only [version]               only download and check the server package
# Needs packer, curl, sha256sum, jq and the GitHub CLI (gh, signed in) for the build attestation check.
# It creates a temporary droplet, which Packer deletes once the snapshot is made (a few cents).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo=quikmn/iskra-voice
fetch_only=false
if [ "${1:-}" = "--fetch-only" ]; then fetch_only=true; shift; fi
version="${1:-$(sed -n "s/^export const RELEASE_VERSION = '\([^']*\)'.*/\1/p" "$here/../../client/src/links.ts")}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "Not a version: '$version'" >&2
  exit 1
fi
package="iskra-server-$version-linux-x64.tar.gz"
base="https://github.com/$repo/releases/download/v$version"
out="$here/build"

for tool in curl sha256sum gh jq; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done
$fetch_only || command -v packer >/dev/null || { echo "packer is required (https://developer.hashicorp.com/packer/install)" >&2; exit 1; }
$fetch_only || [ -n "${DIGITALOCEAN_TOKEN:-}" ] || { echo "Set DIGITALOCEAN_TOKEN (README.md, step 2)" >&2; exit 1; }

# The server package, checked three ways before it goes anywhere near the image: the release's SHA256SUMS.txt, the
# checksum GitHub lists for the file, and its signed build attestation (made by Iskra's release workflow).
rm -rf "$out"
mkdir -p "$out"
curl -fsSL --proto '=https' --tlsv1.2 -o "$out/$package" "$base/$package"
curl -fsSL --proto '=https' --tlsv1.2 -o "$out/SHA256SUMS.txt" "$base/SHA256SUMS.txt"
grep -E "^[0-9a-f]{64} [ *]$package\$" "$out/SHA256SUMS.txt" > "$out/expected"
(cd "$out" && sha256sum -c expected)
actual="$(sha256sum "$out/$package" | cut -d' ' -f1)"
listed="$(gh api "repos/$repo/releases/tags/v$version" --jq ".assets[] | select(.name == \"$package\") | .digest")"
if [ "$listed" != "sha256:$actual" ]; then
  echo "$package doesn't match GitHub's checksum for it ($listed)" >&2
  exit 1
fi
gh attestation verify "$out/$package" -R "$repo"
echo "$package checked."
$fetch_only && exit 0

# The region: the first of these where DigitalOcean offers the build size right now. It drops small sizes from busy
# regions (New York lost s-1vcpu-1gb in 2026-10: four builds failed with 422 "Size is not available in this region"),
# so ask instead of trusting a fixed one. One API call; curl retries a network error 3 times and says so.
size=s-1vcpu-1gb
preferred=(ams3 fra1 lon1 nyc3 nyc1 sfo3 tor1 sgp1 blr1 syd1)
sizes="$(curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-connrefused \
  -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" 'https://api.digitalocean.com/v2/sizes?per_page=200')"
offered="$(jq -r --arg s "$size" '.sizes[] | select(.slug == $s and .available) | .regions[]' <<<"$sizes" | tr -d '\r')"
region=""
for r in "${preferred[@]}"; do
  if grep -qx "$r" <<<"$offered"; then region="$r"; break; fi
done
if [ -z "$region" ]; then
  echo "DigitalOcean offers $size in none of ${preferred[*]} (it does in: $(tr '\n' ' ' <<<"$offered"))" >&2
  exit 1
fi
echo "Building in $region: DigitalOcean offers $size there."

cd "$here"
packer init iskra.pkr.hcl
packer validate -var "iskra_version=$version" -var "region=$region" -var "size=$size" iskra.pkr.hcl
packer build -var "iskra_version=$version" -var "region=$region" -var "size=$size" iskra.pkr.hcl

# The snapshot Packer made, from its manifest ("<region>:<id>"), for test.sh (and the workflow's test job).
artifact="$(sed -n 's/.*"artifact_id": *"\([^"]*\)".*/\1/p' "$out/manifest.json" | tail -n 1)"
if ! [[ "$artifact" =~ ^([a-z0-9]+):([0-9]+)$ ]]; then
  echo "No snapshot ID in $out/manifest.json ('$artifact')" >&2
  exit 1
fi
region="${BASH_REMATCH[1]}"
snapshot="${BASH_REMATCH[2]}"
echo "Snapshot $snapshot in $region. Test it: DIGITALOCEAN_TOKEN=... ./test.sh $snapshot $region"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "snapshot=$snapshot" >> "$GITHUB_OUTPUT"
  echo "region=$region" >> "$GITHUB_OUTPUT"
fi
