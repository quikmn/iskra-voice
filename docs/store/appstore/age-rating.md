# App Store: age rating

App Store Connect → Iskra → **App Information → Age Rating → Edit**. In phase B `scripts/appstore.mjs` sets these
answers through the API from [age-rating.json](age-rating.json) (`ageRatingDeclarations`); if Apple refuses a field
(the questionnaire changes now and then), the run warns and you answer once here. Answer by meaning; the wording moves.

Iskra ships no content of its own (no feed, no media library, no public server list, no default server); everything
comes from the servers people were invited to. So every question about the app's *own* content is **None**:

| Question | Answer |
|---|---|
| Cartoon or fantasy violence, realistic violence, prolonged graphic or sadistic violence | None |
| Guns or other weapons | None |
| Profanity or crude humour | None |
| Mature or suggestive themes, horror or fear themes | None |
| Sexual content or nudity, graphic sexual content and nudity | None |
| Alcohol, tobacco or drug use or references | None |
| Medical or treatment information, health or wellness topics | None / No |
| Simulated gambling, contests | None |
| Gambling (real money), loot boxes | No |
| Unrestricted web access | **No**: links open in Safari; the app only talks to the servers you join |
| **Messaging and chat** | **Yes**: people talk in text, voice and video |
| **User-generated content** | **Yes**: messages, files, images, profiles. Moderation: report and block in the app, server moderators, AutoMod, the Terms (iskra.foo/terms), spark@iskra.foo |
| Advertising | No |
| Parental controls, age assurance | No (the Terms say 13 or older) |
| Made for Kids | **No** |

Expected result: **13+** (Apple's tiers since 2025: 4+, 9+, 13+, 16+, 18+; chat with user-generated content usually
lands at 13+ when it has reporting and blocking). That matches the Terms (13 or older). If Apple gives 16+ or 18+,
accept it: a higher store rating doesn't conflict with the Terms. Don't pick an "age rating override" lower than
the result.
