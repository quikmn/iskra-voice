#!/bin/bash
# After DigitalOcean's cleanup (90-cleanup.sh), whose disk zeroing writes to the kernel log: empty the logs again so the
# image check (99-img-check.sh) finds none.
set -euo pipefail
find /var/log -type f -name '*.log' -exec truncate -s 0 {} +

# Each droplet gets its own machine ID. The build droplet's ID would otherwise ship in the image: journald starts with
# it on first boot, DigitalOcean's first-boot machine_id.sh then replaces an ID that old, and from then on
# `journalctl -u iskra` looks in a journal folder that doesn't exist. With an empty /etc/machine-id, systemd makes a
# new ID at boot before journald starts, and machine_id.sh keeps it (it only replaces an ID older than 10 minutes).
# journald writes to /run for the rest of the build, so the build droplet's own journal (and its shutdown) stays out
# of the image; on first boot it writes to /var/log/journal again.
journalctl --relinquish-var
rm -rf /var/log/journal/*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id
