# Backup and disaster recovery

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10 |
| Applies to | chat.iskra.foo, iskra.foo, app.iskra.foo, the source code and release pipeline, and the owner's keys |

## Objectives

| Service | What's lost if the host is lost | RPO (max data loss) | RTO (time to restore) |
|---|---|---|---|
| chat.iskra.foo (DigitalOcean droplet, world `/opt/iskra/world`) | Database, uploads, server keys | **24 h** (daily backups; see "off-site" below) | **4 h** (new droplet, install, restore, DNS) |
| iskra.foo (Cloudflare Pages) | Nothing: built from `site/` in git | 0 | **1 h** (`deploy.yml` with `site`) |
| app.iskra.foo (Cloudflare Pages) | Nothing: built from `client/` in git | 0 | **1 h** (`deploy.yml` with `webapp`) |
| Source code and releases (GitHub) | Repo, issues, releases | 0 for code (clones on the owner's PC and worktrees) | 1 day (push to a new remote; re-run releases) |
| Signing keys and credentials | See [asset-inventory.md](asset-inventory.md) | 0 (offline copies) | 1 day (restore from offline copy, or renew per docs/ci-cd.md §4) |

## Backups of a server (built into Iskra)

- **Daily backups** in the world's `backups/` folder (`auto-YYYY-MM-DD.zip`): database, settings and keys, the last 7
  by default (1–30), optionally uploads. Not encrypted (they sit next to the keys; owner-only permissions on Linux).
  Code: `server/src/Iskra.Server/Backups/BackupService.cs`. Settings: `server.json` → `Backups`
  ([docs/hosting.md](../../hosting.md)).
- **Downloaded backups** (Settings → Backup & move, or `iskra-server backup <world> <file>`): everything including
  uploads and the server key, encrypted with a passphrase (Argon2id, XChaCha20-Poly1305 in chunks); the passphrase is
  sealed to the server's key in transit. Code: `Backups/BackupFile.cs`, `Backups/BackupArchive.cs`.
- **Off-site:** daily backups live on the same disk. For chat.iskra.foo the owner keeps an encrypted downloaded
  backup off the droplet at least weekly, and/or turns on DigitalOcean droplet backups
  ([owner-actions.md](../owner-actions.md)). Until one of these is done, the real RPO for a lost droplet is the age of
  the newest off-site copy.

## Restore procedure (chat.iskra.foo)

1. Create a new Ubuntu 24.04 droplet (AMS3), harden it as in docs/ci-cd.md §4 "The server" (ufw 22, 80, 443,
   7881/tcp, 7882/udp; unattended-upgrades; swap; UDP buffer sysctls), install the current server bundle.
2. `iskra-server restore <file>.iskrabackup /opt/iskra/world` (asks for the passphrase; `--passphrase-stdin` for
   scripts). A daily `backups/auto-*.zip` restores the same way without a passphrase. The target folder must be new
   or empty ([docs/hosting.md](../../hosting.md) "Restoring").
3. Check `server.json` (`Port`, `PublicUrl`, `Https`), start the `iskra` service. HTTPS certificates aren't in
   backups; Let's Encrypt issues a new one (port 80 open).
4. Point the `chat` A record at the new IP (Cloudflare, DNS only), refresh `DROPLET_HOST` and `DROPLET_KNOWN_HOSTS`
   in GitHub, put the CI key's forced-command line into `authorized_keys`.
5. Verify: the app connects, the server key is unchanged (clients would warn otherwise), recent messages are there,
   voice works. Record the restore in the change log.

## Testing

- **Every CI run:** the `backup-restore-drill` job in `.github/workflows/ci.yml` makes a backup of a seeded test
  world, restores it into a new folder and checks integrity (SQLite `PRAGMA integrity_check`, row counts per table,
  upload file hashes, the server key). Its report is uploaded as the `restore-drill-report` artifact. Plus the
  backup tests in `server/tests/Iskra.Server.Tests/BackupTests.cs`.
- **Yearly:** restore a real chat.iskra.foo backup onto a scratch machine (localhost only) and time it against the
  RTO. Record the result here.

## Continuity of the project

The code is public on GitHub and cloned on the owner's PC. Self-hosted servers keep running without any of the
owner's services. If the owner is unavailable long-term, the backup contact (see
[incident-response.md](incident-response.md)) can post a notice; nobody else holds signing keys by design.

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
