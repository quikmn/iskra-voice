# Release notes

One file per release, named after the version: `2.0.0-alpha.10.md`. It becomes the text of the GitHub release
(`release-finalize.yml` publishes it), so write it for people using Iskra.

- Write it before `npm run release -- <version>`: the script refuses to start without it, and commits it with the version bump.
- Start with a bold one-line headline (`**Iskra: alpha 10.**`), then `### What's new`, `### Fixes`, `### Get started` and `### Good to know`, like the earlier files here.
- File names in "Get started" use the new version (`Iskra-Setup-<version>.exe`).
- The product is just "Iskra". Plain, positive wording.
- The app shows the bold lead of each "What's new" bullet once after an update (`client/src/releaseNotes.ts`, bundled at build time), so make each lead a short highlight on its own. An optional `<version>.sv.md` with its own `### Nytt` section gives Swedish lines; without it the card shows the English ones.

The release process is in [docs/ci-cd.md](../ci-cd.md) (reference) and [docs/ci-cd-playbook.md](../ci-cd-playbook.md) (step by step).
