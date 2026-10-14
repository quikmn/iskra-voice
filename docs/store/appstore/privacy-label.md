# App Store: App Privacy (the privacy "nutrition label")

App Store Connect → Iskra → **App Privacy**. Apple's API can't set this: the owner answers it once (and again only if
the app starts sending something new). The answers match [docs/privacy-connections.md](../../privacy-connections.md),
the Play [data safety answers](../play/data-safety.md) and the privacy policy ([iskra.foo/privacy](https://iskra.foo/privacy)).

**Privacy Policy URL:** `https://iskra.foo/privacy`. (Set through the API with the listing in phase B too.)

## How Iskra maps onto Apple's questions

Apple asks what data "you and/or your third-party partners" **collect**: data transmitted off the device in a way that
lets you or partners access it for longer than needed to service the request in real time.

- The app sends data to one kind of place only: the Iskra servers the person joins, each run by its owner (a friend,
  or themselves). No analytics, ads, crash reporting or third-party SDKs; no push service.
- **We declare it as collected anyway**, the same honest reading as on Play: From a Spark runs servers too
  (chat.iskra.foo, the review server), so people joining those send data to us.
- **End-to-end encrypted data isn't collected** in Apple's sense (nobody but the people in the conversation can read
  it): DMs, group chats, their files, voice messages and calls, encrypted channels, synced settings.
- **Done on the device only, so not collected:** account keys, noise removal, captions, camera effects, clips.
- **Tracking: No.** Nothing is linked with data from other companies' apps or websites for advertising, and nothing
  goes to data brokers.

## Do you or your third-party partners collect data from this app?

**Yes, we collect data from this app.**

## Data types

For each type: **Used for:** App Functionality only. **Linked to the user's identity:** Yes (a server ties it to
your account key). **Used for tracking:** No.

| Apple's category → type | Collect? | What it is in Iskra |
|---|---|---|
| Contact Info → **Name** | Yes | The display name you pick, per-server nicknames |
| Contact Info → Email Address, Phone Number, Physical Address, Other | No | Never asked for |
| Health & Fitness, Financial Info | No | |
| Location (precise, coarse) | No | Never asked for or derived from IPs |
| Sensitive Info | No | |
| Contacts | No | The address book is never read |
| User Content → **Emails or Text Messages** | Yes | Messages in server channels, threads, forums and voice-channel chats (DMs and group chats are end-to-end encrypted and left out) |
| User Content → **Photos or Videos** | Yes | Avatars, images and videos posted in server channels, custom emoji and stickers. Camera video in voice passes live through the server and isn't stored |
| User Content → **Audio Data** | Yes | Voice messages and soundboard sounds in server channels. Live voice passes through and isn't recorded |
| User Content → Gameplay Content | No | |
| User Content → Customer Support | No | Bug reports are sent only when you press Send; they go to Iskra's own server. If the owner wants to be thorough, tick it (App Functionality, linked: No) |
| User Content → **Other User Content** | Yes | Profile fields, reactions, polls and votes, events, files and docs pages, reports you file |
| Browsing History | No | Link previews are fetched by the server |
| Search History | No | Searches run on the server and aren't stored |
| Identifiers → **User ID** | Yes | Your account's public key and device public keys |
| Identifiers → Device ID | No | No IDFA, IDFV or hardware ids; the device key above is an app-made key (counted under User ID) |
| Purchases | No | No purchases; tips are hidden in the phone apps |
| Usage Data (product interaction, advertising data, other) | No | No analytics. Presence (online, in voice) is live state, kept in memory only |
| Diagnostics (crash data, performance data, other) | No | No crash reporting. A bug report's optional logs are sent only when you choose to (see Customer Support) |
| Other Data | No | |

## Result on the listing

"Data Linked to You: Contact Info, User Content, Identifiers", "Data Not Used to Track You". No "Data Used to Track You".

## Re-check when

The app starts sending anything new off the device (for example phone push through a relay, analytics, a new
embed); update this file, data-safety.md and privacy-connections.md together.
