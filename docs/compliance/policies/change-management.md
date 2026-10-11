# Change management

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10 |
| Applies to | Code, workflows, the static sites, the web app, chat.iskra.foo, and vendor/account settings |

## Kinds of change

| Kind | Path to production | Approval |
|---|---|---|
| Code (server, client, desktop, mobile) | Branch → CI green → main → release ([docs/ci-cd.md](../../ci-cd.md) §2) | Owner merges; `release` environment approval for publish and deploy |
| Site text (iskra.foo) | main → `deploy.yml` with `site` | `release` environment approval |
| Web app redeploy (app.iskra.foo) | `deploy.yml` with `webapp` | `release` environment approval |
| chat.iskra.foo server version | `release-finalize.yml` → `deploy.yml` → `iskra-update <version>` over the forced-command SSH key | `release` environment approval |
| Droplet OS packages | unattended-upgrades (security updates) | Automatic; reboots by the owner |
| Credentials, DNS, vendor settings | By hand in the vendor console | Owner; recorded in [asset-inventory.md](asset-inventory.md) or docs/ci-cd.md |
| Emergency fix | Same pipeline, faster: a patch release | As above; note the incident id in the release notes |

## Rules

1. **Everything through the pipeline.** No manual file copies to production; the documented local fallbacks
   (docs/ci-cd.md §3) are for when CI is down, and are recorded afterwards.
2. **Tested before release.** CI is green on the release commit; `release-finalize.yml` refuses to publish if a
   release file is missing or the auto-update hashes don't match.
3. **Traceable.** Each release has notes in `docs/releases/<version>.md`, an annotated tag, a GitHub release with
   `SHA256SUMS.txt`, attestations and SBOMs. Workflow runs keep the logs of who approved what.
4. **Forward-only.** Never move or delete a published tag; fix forward with a new version. Database migrations are
   forward-only.
5. **Rollback.** `iskra-update` rolls back automatically if the new server doesn't come up. To pull a desktop release
   from auto-update, mark it prerelease and the previous one Latest (docs/ci-cd.md §6 "Undoing a release"). The
   server can be put back to the previous version only if no migration ran; otherwise restore from a backup
   ([backup-and-recovery.md](backup-and-recovery.md)).
6. **Separation of environments.** Development and tests run on the developer's machine and CI runners, on
   localhost-only test worlds; production data never enters tests.

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
