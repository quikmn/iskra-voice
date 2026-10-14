# Google Play: App content, store settings and the rest

Everything Play Console asks besides the listing text ([en-US](en-US), [sv-SE](sv-SE)),
[data safety](data-safety.md) and the [content rating](content-rating.md). Items marked **Owner decision** have a
recommendation but are the owner's call.

## Create app (Play Console → Home → Create app)

| Field | Answer |
|---|---|
| App name | `Iskra: voice & text chat` (from `en-US/title.txt`; **Owner decision**: plain `Iskra` also works, the longer name helps search) |
| Default language | English (United States) – en-US |
| App or game | App |
| Free or paid | **Free** (can't be changed to paid later; that's fine, Iskra is free) |
| Declarations | Tick Developer Program Policies and US export laws. Iskra uses only standard published encryption (libsodium, TLS, DTLS-SRTP) in a mass-market app; the same reasoning as the iOS export compliance note in mobile/README.md |

## Policy and programs → App content

| Item | Answer |
|---|---|
| **Privacy policy** | `https://iskra.foo/privacy` |
| **App access** | **All or some functionality is restricted**, with instructions (below) |
| **Ads** | **No, my app does not contain ads** |
| **Content rating** | [content-rating.md](content-rating.md) |
| **Target audience and content** | **Owner decision.** Recommended: ages **13–15, 16–17 and 18+** (the Terms say 13 or older). Not 12 and under. "Could the app unintentionally appeal to children?" **No** (no cartoon style, no child-directed content). Choosing 18+ only is simpler for review but contradicts the Terms, which allow 13+ |
| **News app** | No |
| **COVID-19 contact tracing and status** | My app is not a publicly available COVID-19 contact tracing or status app |
| **Data safety** | [data-safety.md](data-safety.md) |
| **Government apps** | No |
| **Financial features** | My app doesn't provide any financial features |
| **Health** | My app does not have any health features |
| **Advertising ID** | **No**, the app doesn't use an advertising ID (no ads or analytics SDKs; the manifest has no `AD_ID` permission). If the console says the uploaded bundle declares `com.google.android.gms.permission.AD_ID`, stop: something added an SDK |
| **Foreground service permissions** | Declare both types (Android 14+ requires it), see below |
| **Account deletion** | `https://iskra.foo/delete-account` (also asked in Data safety) |

### App access: instructions for reviewers

Phones can't host a server, so a reviewer needs an invite to one. The review server exists since 2026-10-13: **Iskra Review** at `https://chat.iskra.foo:8443` on the droplet (docs/ci-cd.md). The link is the same one as the
repository variable `REVIEW_INVITE_URL`: a member invite made once by the owner with **Invite friends**, **Expires
after: Never**, no use limit (see [../README.md](../README.md)). It keeps working until it's revoked in the same
dialog's **Active invites** list, so paste it here once; only if it's ever revoked does it need a new link here and in
the variable.

Paste into "Add instructions" (name: `Review server`):

```
Iskra has no sign-up: an account is a key created on the phone. Servers are run by their users, so the app needs an
invite link to a server.

1. Open the app, tick "I agree to the Terms of Use" and choose "I'm new to Iskra".
2. Tap "I have an invite link" and paste: <INVITE LINK>
   (Or open the link on the phone; it opens the app.)
3. Pick any name and tap Join. You're in the server's #general channel. Voice channels ("Hangout", "Quiet corner")
   are in the channel list (tap the menu button at the top left to see the channels and your direct messages).

No username or password is needed. Screen sharing and starting your own server are only in the desktop app.
Notifications arrive while the app is open (no push while it's closed).
```

### Foreground service declaration

`VoiceService` (`mobile/android/app/src/main/java/foo/iskra/app/VoiceService.java`) runs while you're in a voice
channel or call, with a visible notification ("In voice: lounge") and a Leave button.

| Type | Use case to pick | Description to paste |
|---|---|---|
| `microphone` | **Voice or video calls** / "Other" if not offered | Keeps the microphone working when you're in a voice channel or call and lock the phone or switch apps. Starts only when you join voice, shows an ongoing notification with a Leave button, and stops when you leave. |
| `mediaPlayback` | **Media playback** | Used instead of `microphone` when the person hasn't allowed the microphone (they're in voice listening only), so you keep hearing the call with the screen off. Same notification and Leave button. |

Play asks for a video showing the feature: record the phone joining a voice channel, the notification appearing,
locking the screen, and tapping Leave in the notification. Upload it unlisted (YouTube) and paste the link. **Owner
action** (needs a phone).

## Store presence → Store settings

| Field | Answer |
|---|---|
| App category | **Communication** (**Owner decision**: Social also fits; Communication is where chat and voice apps live) |
| Tags | Pick up to 5 that the console offers, e.g. Messaging, Voice calling, Video calling, Group chat |
| Email address | `spark@iskra.foo` (shown publicly on the listing) |
| Phone number | Leave empty |
| Website | `https://iskra.foo` |
| External marketing | **Owner decision**; off is fine |

## Store presence → Main store listing

| Field | Source |
|---|---|
| App name, short and full description | `en-US/title.txt`, `short_description.txt`, `full_description.txt` (Swedish: **Translations → Add translations → Swedish – sv-SE**, `sv-SE/*.txt`) |
| App icon (512×512 PNG, 32-bit, ≤ 1 MB) | `docs/store/play/graphics/icon-512.png` (made by the screenshot spec, from the phone app icon, `mobile/scripts/icons.py`) |
| Feature graphic (1024×500 PNG or JPEG, no transparency) | `docs/store/play/graphics/feature-graphic-en.png` / `feature-graphic-sv.png` |
| Phone screenshots (2–8, 9:16, 1080×1920) | `docs/store/play/screenshots/en-US/*.png`, `sv-SE/*.png` |
| Tablet screenshots | Optional; skip (the app is usable on tablets but isn't designed for them yet) |
| Video | None |

Generate the graphics and screenshots (they're git-ignored) with:

```powershell
cd server; dotnet build src/Iskra.Server   # the specs start a real local server (localhost only)
cd client; $env:PLAY_SHOTS=1; $env:ISKRA_E2E_PORT=5299; npx playwright test e2e/play-store.spec.ts
```

## Countries

**Owner decision.** All countries is fine for Play. Two notes from the iOS side (mobile/README.md, export
compliance): France may want a declaration for end-to-end encryption, and that note applies to Play too; if unsure,
leave France out of the production rollout until it's settled. Internal and closed testing aren't public, so they
don't need this yet.
