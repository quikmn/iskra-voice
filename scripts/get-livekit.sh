#!/usr/bin/env bash
# Gets the pinned LiveKit server (v1.13.7) and checks it.
#   scripts/get-livekit.sh          this machine's platform, into .tools/livekit-server
#   scripts/get-livekit.sh <rid>    linux-x64, linux-arm64, osx-arm64 or osx-x64, into .tools/<rid>/livekit-server
# Linux: LiveKit's official release archive, checked against its SHA-256.
# macOS: LiveKit doesn't publish macOS binaries, so it's built from the release's source at the pinned
# commit (Go checks every dependency against go.sum). Runs on a Mac (it needs cgo and Xcode's clang)
# with Go 1.26+, or any Go with GOTOOLCHAIN=auto; either Mac architecture can build both.
set -euo pipefail
version=1.13.7
commit=8d11efdfcd4220092b6ac7b8a21af28526da5a6b

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) host=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) host=linux-arm64 ;;
  Darwin-arm64) host=osx-arm64 ;;
  Darwin-x86_64) host=osx-x64 ;;
  *) host=unknown ;;
esac
rid="${1:-$host}"
tools="$(cd "$(dirname "$0")/.." && pwd)/.tools"
out="$tools"
if [ -n "${1:-}" ]; then out="$tools/$rid"; fi
mkdir -p "$out"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

asset=""
case "$rid" in
  linux-x64)   asset="livekit_${version}_linux_amd64.tar.gz"; sum=6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2 ;;
  linux-arm64) asset="livekit_${version}_linux_arm64.tar.gz"; sum=5d167fdf52cf43c0c72972f25325364479f41f854bfef651056eab2504da5de9 ;;
  osx-arm64)   goarch=arm64 ;;
  osx-x64)     goarch=amd64 ;;
  *) echo "Unsupported platform: $rid (on Windows use scripts/get-livekit.ps1)" >&2; exit 1 ;;
esac

if [ -n "$asset" ]; then
  curl -fsSL -o "$out/$asset" "https://github.com/livekit/livekit/releases/download/v$version/$asset"
  [ "$(sha256 "$out/$asset")" = "$sum" ] || { rm "$out/$asset"; echo "Checksum mismatch for $asset" >&2; exit 1; }
  tar -xzf "$out/$asset" -C "$out" livekit-server
  rm "$out/$asset"
else
  [ "$(uname -s)" = Darwin ] || { echo "Build the macOS LiveKit on a Mac" >&2; exit 1; }
  src="$(mktemp -d)"
  trap 'rm -rf "$src"' EXIT
  git clone --quiet --depth 1 --branch "v$version" https://github.com/livekit/livekit "$src" 2>/dev/null
  [ "$(git -C "$src" rev-parse HEAD)" = "$commit" ] || { echo "v$version isn't the expected commit" >&2; exit 1; }
  (cd "$src" && CGO_ENABLED=1 GOOS=darwin GOARCH="$goarch" go build -trimpath -ldflags "-s -w" -o "$out/livekit-server" ./cmd/server)
fi
chmod +x "$out/livekit-server"
echo "livekit-server $version ($rid) is in $out"
