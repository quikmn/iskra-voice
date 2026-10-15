# The phone apps in the stores

Every release puts the phone apps in the stores by itself: `scripts/release.ps1` dispatches
`.github/workflows/mobile-ios.yml` on the release tag (build, upload, then `scripts/appstore.mjs`) and uploads the
Android app bundle with `scripts/play-upload.mjs`. Where they go is one file, [mobile/store.json](../../mobile/store.json).
The only thing the owner does per release is log in to SimplySign Desktop for the Windows signing (release.ps1 checks
it first and says so).

| | Phase A: testing (now) | Phase B: public listings |
|---|---|---|
| `mobile/store.json` | `"ios": { "mode": "testflight" }`, `"android": { "track": "alpha", "listing": false }` | `"ios": { "mode": "appstore" }`, `"android": { "track": "production", "listing": true }` (`"rollout": 0.2` for a staged rollout) |
| iPhone and iPad | Waits for Apple's processing, export compliance answered, "What to test" (en-US, sv) from the release notes, TestFlight test information and review contact, added to every internal group and the external group of the public link `r4tMgn3D`, submitted for Beta App Review. Testers get it without a click once Apple approves | All of phase A, then the App Store version: created or reused, the build, What's New, name, subtitle, promotional text, description, keywords, URLs, screenshots ([appstore/screenshots](appstore/screenshots)), age rating, App Review information with the review invite, submitted for review, **released automatically when approved** |
| Android | The bundle on Play's closed testing track (`alpha`), status completed, release notes en-US + sv-SE | The bundle on production (100 %, or staged with `rollout`), plus the listing text from [play](play) and the graphics the screenshot spec made; with `"dataSafety": true` also the Data safety form from `play/data-safety.csv` |
| Release notes | `docs/releases/<version>.md`; Swedish from `docs/releases/<version>.sv.md` if it exists, else one Swedish line with the link | the same |

Before anything is sent, release.ps1's check phase checks mobile/store.json, the Play key (presence only), the
`APPSTORE_*` secrets and, in phase B, `REVIEW_INVITE_URL`. A failed phone step never undoes the release: release.ps1 runs the final checks, then prints
`STOP [phones] ...`; `release.ps1 -Resume` retries only what didn't finish. `-SkipPhones` leaves the
stores alone; `-PlayTrack <track>` overrides the track once; `release.ps1 -Phones` does only the phone apps of the latest
release.

## One-time setup (the owner)

### Google Play service account (for the uploads)

1. **Google Cloud project.** console.cloud.google.com → project picker → **New project** `iskra-play` → Create.
2. **Turn on the API.** APIs & Services → Library → **Google Play Android Developer API** → Enable.
3. **Service account.** IAM & Admin → Service accounts → **Create service account**: name `iskra-play-publisher`,
   no roles (Play grants its permissions) → Done. Open it → **Keys → Add key → Create new key → JSON**. Save the
   downloaded file as **`D:\Development_Projects\devkeys\google-play-service-account.json`** (nowhere else; never
   commit or paste it). Copy the account's email (`iskra-play-publisher@iskra-play.iam.gserviceaccount.com`).
4. **Play Console permission.** play.google.com/console → **Users and permissions → Invite new users** → the
   service account's email → **App permissions → Add app → Iskra** → tick **Release apps to testing tracks**,
   **Release to production, exclude devices, and use Play App Signing**, **Manage testing tracks and edit tester lists**
   and (for phase B listings) **Manage store presence** → Apply → **Invite user**. (Account permissions: none.)
   It can take up to 24 hours before the API accepts the new account.
5. **Check (read only):** `node scripts/play-upload.mjs --list-tracks` prints the app's track names. The closed testing
   track Play makes is `alpha`; if you made your own closed track, its name is listed: put it in `mobile/store.json`
   `android.track`.

Without the key file, release.ps1's check phase is red ("Google Play key") and nothing is sent; `-SkipPhones` releases
without the phone apps.

### App Store Connect (once)

The `APPSTORE_*` secrets (Admin key) already build and upload. Also:

1. **TestFlight groups.** The internal group with automatic distribution (mobile/README.md step 5) and the external
   group behind the public link `r4tMgn3D` exist. Its public link stays on (TestFlight → the group → Public Link).
   Another external group: add `{ "name": "<group>" }` to `ios.externalGroups` in mobile/store.json.
2. **Review contact phone** (Apple requires one for Beta App Review and App Review):
   `gh secret set APPSTORE_REVIEW_PHONE` and type it (e.g. `+46 70 123 45 67`). It never goes into the repo.
3. **Review invite (once):** on the review server (`https://chat.iskra.foo:8443`), as its owner, open **Invite
   friends**, set **Expires after** to **Never** (admins and owners only), leave **Single use** off, copy the link and
   `gh variable set REVIEW_INVITE_URL --body "<invite link>"`. It never expires, so there is nothing to renew; it shows
   as **Never expires** under **Active invites** in the same dialog, where it can be revoked (then make a new one and
   set the variable again). Use the same link in Play's app access instructions. Without the variable the review notes
   say to write to spark@iskra.foo, and phase B refuses to submit.

### CI results in a channel (optional)

See docs/ci-cd.md, "CI results in Iskra": an incoming webhook in a channel, then `gh secret set ISKRA_CI_WEBHOOK`.

## Phase A → phase B: what only a person can do

The APIs can't do these; each is done **once** in the browser. Then flip `mobile/store.json` (below).

### Google Play

1. **Content rating** questionnaire ([play/content-rating.md](play/content-rating.md)).
2. **App content** forms: privacy policy, app access (review invite), ads, target audience, news, government,
   financial, health, advertising ID, account deletion ([play/app-content.md](play/app-content.md)).
3. **Data safety** the first time ([play/data-safety.md](play/data-safety.md)). Then Policy and programs → App content →
   Data safety → **Export to CSV**, save it as `docs/store/play/data-safety.csv` and set `"dataSafety": true`: from then
   on releases keep it in sync through the API.
4. **Foreground service declaration** with the video (microphone and media playback).
5. **Store settings**: category Communication, contact email, website (no API).
6. **Closed test: 12 testers opted in for 14 days** (new personal accounts), then **Dashboard → Apply for production**
   and wait for Google's answer. The texts for a tester service and Play's feedback field are in
   [testers-kit.md](testers-kit.md); testers follow [docs/testers.md](../testers.md).
7. **Countries** for production (Production → Countries/regions). France: see the encryption note in
   [appstore/README.md](appstore/README.md).
8. Play App Signing is set up with the first upload (playbook L.4), already done in phase A.

### App Store

1. **App Privacy** (the privacy label): [appstore/privacy-label.md](appstore/privacy-label.md). No API.
2. **Age rating**: set by the API in phase B from [appstore/age-rating.json](appstore/age-rating.json); if the run warns,
   answer it once from [appstore/age-rating.md](appstore/age-rating.md).
3. **Pricing and availability**: Price **Free (0)**, all countries except as noted (China mainland: CallKit isn't
   allowed there, leave it out; France: the ANSSI note). App Store Connect → Pricing and Availability.
4. **EU Digital Services Act trader status**: Business → **Trader status**. A status must be declared or the app isn't
   available in the EU. **Not a trader** (a free, non-commercial project: no sales, no ads) publishes nothing. **Trader**
   (offering apps as a business, even free) makes Apple show an address, phone and email on EU listings, verified by
   Apple: use a separate number and a business or P.O. box address, not a private one. The owner's call (not legal
   advice); donations make it a judgement call.
5. **App Store category**: Social Networking (primary), Productivity or none (secondary). App Information.
6. **Content rights**: "Does your app contain, show, or access third-party content?" **Yes** (people's own content
   and embeds they choose to load), "I have the necessary rights" (the Terms). App Information.
7. Agreements, tax and banking aren't needed for a free app (the Free Apps agreement is active).

### Flip to phase B

When every item above is done and Play has granted production access: in a commit on main,

```json
"ios": { "mode": "appstore", ... },
"android": { "track": "production", "rollout": 1, "listing": true, ... }
```

(`"rollout": 0.2` for the first production release if you want a staged rollout; raise it in Play Console or with a later
release). The next release then fills and submits the App Store version and publishes on Play. Note: the App Store
version is the numeric part of the app version (`2.0.0-alpha.20` → `2.0.0`); once a `2.0.0` is approved, the next
release must be a higher version (2.0.1 or 2.1.0-alpha.1), or the step stops with "already approved or on sale".
