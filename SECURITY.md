# Security policy

Thanks for helping keep Iskra and the people who use it safe. If you think you've found a security problem, please tell us privately first, so we can fix it before it's public.

## Reporting a vulnerability

- **Preferred:** [report it privately on GitHub](https://github.com/quikmn/iskra-voice/security/advisories/new) (Security → Report a vulnerability). Only the maintainer sees it, and we can work on the fix and the advisory together.
- **Or email** [spark@iskra.foo](mailto:spark@iskra.foo).

Please include what's affected (app, server, desktop or phone app, website), the version, steps to reproduce or a proof of concept, and what an attacker could do with it. English or Swedish are both fine. Please don't open a public issue for a security problem.

## What's in scope

- The code in this repository: the web app (`client/`), the server (`server/`), the desktop app (`desktop/`), the phone apps (`mobile/`, `android/`), the bot SDK (`bots/`) and the wire protocol (`protocol/`).
- Our own services: [iskra.foo](https://iskra.foo), [app.iskra.foo](https://app.iskra.foo) and [chat.iskra.foo](https://chat.iskra.foo).
- The release pipeline and published release files (GitHub releases, build attestations, SBOMs).

Out of scope:

- Servers other people run themselves, when the problem comes from how they set them up (for example a server without HTTPS, or an owner reading their own server's channels, which is how Iskra works; see [docs/security.md](docs/security.md#limitations)).
- Social engineering, phishing or physical attacks on people.
- Denial of service by sheer volume (flooding, load tests). Please don't run them against our services. A request that makes a server crash or use unbounded resources is in scope: describe it, and test it on a server of your own.
- Reports from automated scanners without a demonstrated impact, missing best-practice headers on pages without user data, and problems in third-party services (report those to the vendor).

## What to expect

| Step | Target |
|---|---|
| We confirm we got your report | within 3 business days |
| First assessment (is it real, how severe) | within 7 days |
| Fix released, **critical** | within 7 days |
| Fix released, **high** | within 30 days |
| Fix released, **medium** | within 90 days |
| Fix released, **low** | best effort, usually with the next release |

Severity follows CVSS v4 as a guide, adjusted for how Iskra is actually used. We'll keep you posted, tell you when the fix ships, and credit you in the advisory and release notes if you'd like.

**Coordinated disclosure:** please give us up to 90 days from your report before publishing details, or until a fix is released, whichever comes first. If we need longer, we'll explain why and agree on a date with you.

## Safe harbour

We won't take legal action against research done in good faith under this policy: that means you avoid privacy violations and damage to data or services, only access what you need to show the problem, use test accounts and servers of your own where you can, don't keep or share anyone else's data, and give us reasonable time to fix it before you publish. If you're unsure whether something is OK, ask first.

## Supported versions

Security fixes go into the **latest release** only. The desktop apps update themselves; self-hosted servers update by installing the newest `iskra-server` ([docs/hosting.md](docs/hosting.md)). Please check a problem against the latest release before reporting it.

## More

- How Iskra protects people, and its known limitations: [docs/security.md](docs/security.md)
- Machine-readable contact: [iskra.foo/.well-known/security.txt](https://iskra.foo/.well-known/security.txt)
