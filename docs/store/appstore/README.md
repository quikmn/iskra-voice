# App Store listing kit

Everything App Store Connect asks for Iskra (`foo.iskra.app`), in English (`en-US/`) and Swedish (`sv/`, App Store
Connect's code for Swedish). In phase B `scripts/appstore.mjs` uploads all of it through the App Store Connect API on
every release ([../README.md](../README.md)); until then it's the reference for the forms. How the phases work and what
only a person can do: [../README.md](../README.md).

| File | App Store Connect field | Limit |
|---|---|---|
| `<locale>/name.txt` | App Information → Name | 30 |
| `<locale>/subtitle.txt` | App Information → Subtitle | 30 |
| `<locale>/promotional_text.txt` | Version → Promotional Text (can change without a review) | 170 |
| `<locale>/description.txt` | Version → Description | 4000 |
| `<locale>/keywords.txt` | Version → Keywords (comma separated, no spaces after commas, no other apps' names) | 100 |
| `<locale>/support_url.txt` | Version → Support URL: `https://iskra.foo/support` | |
| `<locale>/marketing_url.txt` | Version → Marketing URL: `https://iskra.foo` | |
| `<locale>/privacy_url.txt` | App Information → Privacy Policy URL: `https://iskra.foo/privacy` | |
| What's New | From `docs/releases/<version>.md` (and `<version>.sv.md`), made by the script | 4000 |
| [review-notes.txt](review-notes.txt) | Version → App Review Information → Notes (also TestFlight's Beta App Review notes); `{{INVITE}}` becomes the repo variable `REVIEW_INVITE_URL` | 4000 |
| [age-rating.json](age-rating.json), [age-rating.md](age-rating.md) | App Information → Age Rating | |
| [privacy-label.md](privacy-label.md) | App Privacy (by hand, no API) | |
| `screenshots/<locale>/iphone/*.png` | iPhone 6.9" display (1320×2868), 6 per language | 10 |
| `screenshots/<locale>/ipad/*.png` | iPad 13" display (2064×2752), 6 per language | 10 |

The limits are checked by `scripts/appstore.test.mjs` (root `npm test`). The tests and the script read the same files,
so keep the names.

## Review access and user-generated content (guideline 1.2)

[review-notes.txt](review-notes.txt) tells the reviewer how to get in (no account needed: an invite to **Iskra Review**,
`https://chat.iskra.foo:8443`, the review server on the droplet, docs/ci-cd.md) and lists the measures Apple wants for
apps with user content: Terms accepted before use with zero tolerance for objectionable content, Report on every
message and person (to the server's moderators, with a queue), Block, moderation tools (delete, timeout, kick, ban,
slow mode, AutoMod, activity log), and the contact for safety reports (spark@iskra.foo, iskra.foo/support#safety).
App Review Information's contact (name, email from mobile/store.json, phone from the secret `APPSTORE_REVIEW_PHONE`) is
set by the script; **Sign-in required: No**.

## Export compliance

`ITSAppUsesNonExemptEncryption = false` in Info.plist, and the script sets `usesNonExemptEncryption: false` on each
build if Apple didn't, so no build waits on the question. Reasoning (standard algorithms in a mass-market app, EAR
5D992.c) and the open points in [mobile/README.md](../../../mobile/README.md#export-compliance). **France:** supplying
end-to-end encryption there may need a declaration to ANSSI; until the owner has filed it (or decided it isn't needed),
leave France out of the App Store availability (TestFlight isn't a store listing).

## Screenshots

Made by `client/e2e/app-store.spec.ts` with made-up demo content, in the app as it runs on iOS (the same screens as the
Play screenshots, client/e2e/storeShots.ts):

```powershell
cd server; dotnet build src/Iskra.Server   # the spec starts real local servers (localhost only)
cd client; $env:APPSTORE_SHOTS=1; $env:ISKRA_E2E_PORT=5299; npx playwright test e2e/app-store.spec.ts
```

They're committed (the release workflow uploads them from the repo). Run the spec again after a visible UI change and
commit the new PNGs; the script replaces a set only when its files changed. Apple scales them down for smaller
iPhones and iPads.

## From TestFlight to a public listing (owner checklist)

In order; each item once. Details in [../README.md](../README.md#phase-a--phase-b-what-only-a-person-can-do).

1. [ ] App Privacy answered from [privacy-label.md](privacy-label.md), then **Publish**.
2. [ ] Pricing and Availability: **Free**; countries: all except China mainland (CallKit) and, until the ANSSI question is
       settled, France.
3. [ ] Business → **EU trader status** declared (not a trader: nothing published; trader: address, phone and email shown on EU listings, so use separate ones), or the app stays out of the EU.
4. [ ] App Information: category **Social Networking**, content rights answered.
5. [ ] `gh secret set APPSTORE_REVIEW_PHONE` and `gh variable set REVIEW_INVITE_URL` (a member invite to the review
       server that never expires; set once, see [../README.md](../README.md)).
6. [ ] Flip `mobile/store.json` to `"mode": "appstore"` in a commit (with Play's flip if it's ready too).
7. [ ] The next release submits the version. If the run warns about the age rating, answer it from
       [age-rating.md](age-rating.md) and rerun the iOS workflow's failed job (or `release.ps1 -Resume`).
8. [ ] Apple approves → the version goes on sale by itself (release type "after approval").
