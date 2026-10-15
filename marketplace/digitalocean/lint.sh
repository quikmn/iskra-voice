#!/bin/bash
# Checks the image files without building anything or calling DigitalOcean (CI: .github/workflows/marketplace.yml):
# ShellCheck on our scripts, bash -n on DigitalOcean's vendored ones, and packer validate with a dummy token and
# a dummy package.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

ours=(
  build.sh
  test.sh
  lint.sh
  scripts/10-install.sh
  files/usr/local/sbin/iskra-claim-screen
  files/var/lib/cloud/scripts/per-instance/10-iskra-world
  files/etc/update-motd.d/99-iskra
)
shellcheck --version | head -n 2
shellcheck "${ours[@]}"
for f in vendor/*.sh; do bash -n "$f"; done
echo "Scripts OK."

if ! command -v packer >/dev/null; then
  echo "packer isn't installed: skipped packer validate." >&2
  [ -z "${CI:-}" ] || exit 1
  exit 0
fi
dummy="$(mktemp -d)"
trap 'rm -rf "$dummy"' EXIT
touch "$dummy/iskra-server-0.0.0-linux-x64.tar.gz" "$dummy/SHA256SUMS.txt"
packer fmt -check -diff iskra.pkr.hcl
packer init iskra.pkr.hcl
packer validate -var do_token=dummy -var iskra_version=0.0.0 -var "package_dir=$dummy" iskra.pkr.hcl
