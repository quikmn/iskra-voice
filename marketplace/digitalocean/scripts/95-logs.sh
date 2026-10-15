#!/bin/bash
# After DigitalOcean's cleanup (90-cleanup.sh), whose disk zeroing writes to the kernel log: empty the logs again so the
# image check (99-img-check.sh) finds none.
set -euo pipefail
find /var/log -type f -name '*.log' -exec truncate -s 0 {} +
