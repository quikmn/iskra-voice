# DPIA screening: end-to-end encrypted chat

| | |
|---|---|
| Owner | Viktor Lundgren — spark@iskra.foo |
| Version | 1.0, 2026-10-11 |
| Next review | 2027-10, or before a change listed under "Triggers to redo" |
| Processing | chat.iskra.foo (and the Iskra software as designed): voice/text chat, DMs, group chats and calls end-to-end encrypted |

GDPR Art. 35 requires a full data protection impact assessment (DPIA) when processing is "likely to result in a
high risk". This screening uses the EDPB/WP29 criteria (WP248 rev.01) and IMY's list of processing that requires a
DPIA. A DPIA is generally needed when two or more criteria are met.

## Criteria

| # | Criterion | Applies? | Reasoning |
|---|---|---|---|
| 1 | Evaluation or scoring, profiling | No | No profiling, recommendations, ads or analytics |
| 2 | Automated decisions with legal or similar effect | No | AutoMod can block a message by an admin's word list; a human admin configures and reviews it; no legal effect |
| 3 | Systematic monitoring | No | No monitoring of members; the security log records security events only (failed sign-ins, rate limits, admin actions), not behaviour or content |
| 4 | Sensitive data or highly personal data | **Partly** | Private conversations are "highly personal". Mitigated: DMs, group chats and their calls are end-to-end encrypted; the server holds ciphertext and delivery metadata only. Server channels are readable by the server owner, as users are told |
| 5 | Large scale | No | One friend server (a handful to tens of members) |
| 6 | Matching or combining datasets | No | Each server is separate; no central account database |
| 7 | Vulnerable data subjects | **Possibly** | Minimum age 13; children 13–17 may use it. Mitigated by terms (age rule, zero tolerance), reporting, blocking, moderation tools, no public discovery |
| 8 | Innovative use of technology | **Partly** | Custom E2EE design (prekeys, signed group chains) built from standard libsodium primitives; not novel processing purposes |
| 9 | Prevents exercising a right or using a service | No | Joining is by invite; rights are exercisable in the app (export, deletion) |

## Conclusion

Three criteria apply partly or possibly (4, 7, 8), each with strong mitigations, at very small scale on a server
for the owner's own friend group. **A full DPIA is not required at present**, but the screening is kept and the
residual risks are tracked in the [risk register](risk-register.md):

- Metadata (who talks to whom, when) remains visible to the server — documented in docs/security.md "Limitations".
- Server channels are not end-to-end encrypted — stated in the app and the privacy policy.
- Minors — handled by terms, moderation and the ability to report to spark@iskra.foo.

## Triggers to redo (and likely do a full DPIA)

- Hosting servers for others commercially, or any server beyond the friend group (large scale).
- Adding analytics, profiling, content scanning, recommendations or AI processing of messages.
- Weakening end-to-end encryption (e.g. server-side search or backup of DMs).
- Targeting children or schools.
- Any central service that sees users of many servers beyond the push relay as screened below.

## Push relay (screened 2026-10-11)

The phone apps get notifications through push.iskra.foo (relay/README.md), a central service used by every server's
phone users. It stores nothing (no device list, no logs of tokens or bodies); payloads are end-to-end encrypted from
the Iskra server to the phone, so the relay, Apple and Google see a device token, the sending server's IP, time,
ciphertext size and whether it's a call. Handles are bound to one server, so the relay can't be used to link a
person across servers by anything but the device token (which only the relay sees). Result: no high risk; no full
DPIA. Redo if the relay starts storing anything, logging, or reading payloads.

## Change log

| Date | Change |
|---|---|
| 2026-10-11 | First version |
| 2026-10-11 | Push relay screened |
