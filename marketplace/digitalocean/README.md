# Iskra on the DigitalOcean Marketplace

The Iskra 1-Click image ("Create Iskra Droplet"): a droplet that runs an Iskra server, which its owner claims from
the Iskra app with a code shown on the droplet's console. What users see: [docs/hosting.md, DigitalOcean
Marketplace](../../docs/hosting.md#digitalocean-marketplace). The listing text: [listing.md](listing.md).

| Path | What it is |
|---|---|
| `iskra.pkr.hcl` | Packer template: Ubuntu 24.04 on the $6 size (`s-1vcpu-1gb`), the DigitalOcean plugin pinned to 1.4.1 |
| `build.sh` | Downloads the server package, checks it (SHA256SUMS.txt, GitHub's checksum, the build attestation), then runs Packer and prints the snapshot's ID |
| `test.sh` | Tests a snapshot end to end on a temporary $6 droplet (below), then deletes the droplet and its SSH key; `--sweep` deletes leftovers |
| `lint.sh` | ShellCheck and `packer validate` with a dummy token (CI: `.github/workflows/marketplace.yml`) |
| `scripts/10-install.sh` | Runs in the build droplet: the server in `/opt/iskra`, services, ufw, unattended-upgrades. No world folder |
| `files/var/lib/cloud/scripts/per-instance/10-iskra-world` | First boot of each droplet: its own `server.json` (`"OwnerClaim": "generate"`, HTTPS on `<ip>.sslip.io`, auto updates, daily backups), starts Iskra |
| `files/usr/local/sbin/iskra-claim-screen` | The address and claim code on the console (`/etc/issue`), in the login message (`/etc/update-motd.d/99-iskra`) and in `/root/iskra-claim.txt`; a timer keeps it current until the server has an owner, then restores the console |
| `files/etc/systemd/system/` | `iskra.service` (same as docs/hosting.md and the app's rental setup), the claim screen's service and timer |
| `vendor/` | DigitalOcean's `90-cleanup.sh` and `99-img-check.sh`, unchanged, from [marketplace-partners](https://github.com/digitalocean/marketplace-partners) at commit `b70878804ca27c01d5f5e882d26485defbaba210` (Apache 2.0, `vendor/LICENSE.md`) |

The image never holds a world folder, keys, certificates, SSH keys or a root password: each droplet's server makes its
own keys on first start, and DigitalOcean's cleanup and image check run last in every build (the build fails if the
check fails).

## Owner's steps

Nothing here runs by itself. CI only lints these files on changes; building and testing need your DigitalOcean token
and a press of **Run workflow** (only people with write access to the repository can press it).

### 1. Apply as a vendor (once)

1. Fill in the form at [marketplace.digitalocean.com/vendors](https://marketplace.digitalocean.com/vendors): your
   name (or company), contact email (`spark@iskra.foo`, which must receive mail), and the product: "Iskra, a free,
   self-hosted voice and text chat server for friend groups", type **Droplet 1-Click App**.
2. Wait for the invitation to the vendor portal. Ask there for what isn't public: review time, logo sizes, field
   lengths.

### 2. A DigitalOcean project and token for image builds (once)

1. In DigitalOcean, make a separate project (for example "Iskra image builds"): only build droplets and test droplets
   live there.
2. API → Tokens → **Generate New Token**, 90 days, **Custom Scopes**: *droplet* (create, read, update, delete: update powers the build droplet off for the snapshot), *image* (create, read,
   update: create makes the snapshot), *snapshot* (read), *regions* (read), *sizes* (read), *ssh_key* (create, read, delete), *tag* (create,
   read), *actions* (read), *vpc* (read, added by DigitalOcean). The build (Packer) and the test (`test.sh`) each make a temporary SSH key and droplet and
   delete both afterwards. If a run fails on a missing scope (the log shows DigitalOcean's message), use full access
   for that run and delete the token right after.
3. On GitHub: Settings → Environments → **New environment** `marketplace`, **no** required reviewers, and the secret
   `DO_MARKETPLACE_TOKEN` = the token. Only `.github/workflows/marketplace.yml` uses it. (The first run also creates
   the environment, without the secret; then add the secret and run again.)

### 3. Build and test the image (one run)

On GitHub: Actions → **Marketplace image** → **Run workflow** (optionally a version; empty = the release the app links
to). About 25 minutes, no approvals, then a pass or a fail:

1. **build**: the snapshot, named `iskra-<version>-<date>` (Images → Snapshots); the build droplet is deleted.
2. **test**: a $6 droplet from that snapshot, in the same region, tagged `iskra-image-test`, exactly as "Create Iskra
   Droplet" makes it. It checks what a user meets: the claim code on the console (`/etc/issue`), in the login message
   and in `/root/iskra-claim.txt`; `iskra` running; ufw allowing only 22, 80, 443, 7881/tcp and 7882/udp; HTTPS with
   a real certificate on `<ip-with-dashes>.sslip.io` and voice up (`/health`). Then it claims the server with the
   app's own code (`client/interop/claim.test.ts`: a new identity, address + code, a wrong code refused, joined as
   the owner, the code then used up, a voice token and a LiveKit room joined) and checks the console went back to
   normal. The claim code is masked in the log.
3. **cleanup**: the test droplet and its SSH key are always deleted (also after a failure or a cancel; any droplet
   tagged `iskra-image-test` or `iskra-image-build` is swept). The snapshot is kept, pass or fail: its ID is in the
   run's summary. A failed test prints the droplet's setup log and the server's log first.

A snapshot costs a few cents a month; delete old ones (and the one from a failed run).

Or on your computer (Linux, macOS or WSL; needs [Packer](https://developer.hashicorp.com/packer/install), `curl`,
`sha256sum` and the GitHub CLI signed in; for the test also `jq`, `ssh` and Node, with `npm ci` in `client/` and
`bots/`):

```sh
cd marketplace/digitalocean
DIGITALOCEAN_TOKEN=dop_v1_... ./build.sh              # or ./build.sh 2.0.0-alpha.16; prints the snapshot ID
DIGITALOCEAN_TOKEN=dop_v1_... ./test.sh <snapshot-id> <region>
```

### 4. Try it yourself (optional)

The test covers the claim and voice; to see it as a user does, create a droplet from the snapshot (Images → Snapshots
→ More → Create Droplet, $6 size), open its **Console** for the address and claim code, and in the Iskra app **Join a
server → Claim it**. Check chat, a voice call, and that a friend can join with an invite. Destroy the droplet after.

### 5. Submit

1. Vendor portal → **Create a new app** (Droplet 1-Click) → pick the snapshot, Ubuntu 24.04, and fill in the listing
   from [listing.md](listing.md). Software included: Iskra server (PolyForm Noncommercial 1.0.0, see `LICENSE`: free
   for people's own use; mention it if the form asks about the license), LiveKit server 1.13.7 (Apache 2.0), the .NET
   runtime (MIT, inside the server).
2. Logo: the app icon (`client/public/favicon.svg`, `client/public/icons/icon-512.png`), as SVG and PNG, at the size the portal asks for. Screenshots: from
   `client/e2e/screenshots` (desktop and phone).
3. Answer review questions; expect a round or two (ufw rules, cleanup). Once approved you get the listing URL; the
   deploy link is that URL plus `?action=deploy`.

### 6. After it's live

- Turn the note in docs/hosting.md ("The listing is on its way") into the listing link, and add the deploy link to
  the site (DigitalOcean's Welcome Kit has a "Deploy to DigitalOcean" button).
- Rebuild the image every few releases (droplets update themselves, so an older image is fine) and update it in the
  vendor portal.
