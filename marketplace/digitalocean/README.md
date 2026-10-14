# Iskra on the DigitalOcean Marketplace

The Iskra 1-Click image ("Create Iskra Droplet"): a droplet that runs an Iskra server, which its owner claims from
the Iskra app with a code shown on the droplet's console. What users see: [docs/hosting.md, DigitalOcean
Marketplace](../../docs/hosting.md#digitalocean-marketplace). The listing text: [listing.md](listing.md).

| Path | What it is |
|---|---|
| `iskra.pkr.hcl` | Packer template: Ubuntu 24.04 on the $6 size (`s-1vcpu-1gb`), the DigitalOcean plugin pinned to 1.4.1 |
| `build.sh` | Downloads the server package, checks it (SHA256SUMS.txt, GitHub's checksum, the build attestation), then runs Packer |
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

Nothing here runs by itself. CI only lints these files; building needs your DigitalOcean token and your approval.

### 1. Apply as a vendor (once)

1. Fill in the form at [marketplace.digitalocean.com/vendors](https://marketplace.digitalocean.com/vendors): your
   name (or company), contact email (`spark@iskra.foo`, which must receive mail), and the product: "Iskra, a free,
   self-hosted voice and text chat server for friend groups", type **Droplet 1-Click App**.
2. Wait for the invitation to the vendor portal. Ask there for what isn't public: review time, logo sizes, field
   lengths.

### 2. A DigitalOcean project and token for image builds (once)

1. In DigitalOcean, make a separate project (for example "Iskra image builds"): only build droplets and test droplets
   live there.
2. API → Tokens → **Generate New Token**, 90 days, **Custom Scopes**: *droplet* (create, read, delete), *image* (read,
   update), *snapshot* (read), *regions* (read), *sizes* (read), *ssh_key* (create, read, delete), *tag* (create),
   *actions* (read). Packer makes a temporary SSH key and droplet and deletes both afterwards. If a build fails on a
   missing scope, use full access for that build and delete the token right after.
3. For builds from GitHub: Settings → Environments → **New environment** `marketplace`, with **Required reviewers**
   (you) and the secret `DO_MARKETPLACE_TOKEN` = the token. Only `.github/workflows/marketplace.yml` uses it.

### 3. Build the image

On GitHub: Actions → **Marketplace image** → **Run workflow** (optionally a version; empty = the release the app links
to) → approve the run.

Or on your computer (Linux, macOS or WSL; needs [Packer](https://developer.hashicorp.com/packer/install), `curl`,
`sha256sum` and the GitHub CLI signed in):

```sh
cd marketplace/digitalocean
DIGITALOCEAN_TOKEN=dop_v1_... ./build.sh              # or ./build.sh 2.0.0-alpha.16
```

About 10 minutes. The result is a snapshot named `iskra-<version>-<date>` in that project (Images → Snapshots); the
build droplet is deleted. A snapshot costs a few cents a month; delete old ones.

### 4. Test it by hand

1. Create a droplet from the snapshot (Images → Snapshots → More → Create Droplet), $6 size, any region, password
   login.
2. After a minute, open its **Console**: the screen shows the address and a claim code. If it says "starting", wait a
   minute and press Enter.
3. In the Iskra app: **Join a server → Claim it**, address + code → **Join as owner**. Check chat, a voice call, and
   that a friend can join with an invite.
4. Check: `systemctl status iskra`, `ufw status` (22, 80, 443, 7881/tcp, 7882/udp), `/var/log/iskra-setup.log`, and
   that the console looks normal again after the claim (`cat /etc/issue`).
5. Destroy the droplet.

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
