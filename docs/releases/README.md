# Release notes

One file per release, named after the version: `2.0.0-alpha.10.md`. It becomes the text of the GitHub release
(`release-finalize.yml` publishes it), so write it for people using Iskra.

- Write it before `npm run release -- <version>`: the script refuses to start without it, and commits it with the version bump.
- Start with a bold one-line headline (`**Iskra: alpha 10.**`), then `### What's new`, `### Fixes`, `### Get started` and `### Good to know`, like the earlier files here.
- File names in "Get started" use the new version (`Iskra-Setup-<version>.exe`).
- The product is just "Iskra". Plain, positive wording.

The release process is in [docs/ci-cd.md](../ci-cd.md) (reference) and [docs/ci-cd-playbook.md](../ci-cd-playbook.md) (step by step).
