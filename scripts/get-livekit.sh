#!/usr/bin/env bash
# Downloads the pinned LiveKit server into .tools and checks its SHA-256 (Linux x64).
set -euo pipefail
version=1.13.7
asset="livekit_${version}_linux_amd64.tar.gz"
sha256=6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2

tools="$(cd "$(dirname "$0")/.." && pwd)/.tools"
mkdir -p "$tools"
curl -fsSL -o "$tools/$asset" "https://github.com/livekit/livekit/releases/download/v$version/$asset"
echo "$sha256  $tools/$asset" | sha256sum -c -
tar -xzf "$tools/$asset" -C "$tools" livekit-server
rm "$tools/$asset"
echo "livekit-server $version is in $tools"
