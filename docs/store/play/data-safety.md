# Google Play: Data safety answers

Play Console → Iskra → **Policy and programs → App content → Data safety**. Answers for the Android app
(`foo.iskra.app`, `mobile/android`), derived from the code, [docs/privacy-connections.md](../../privacy-connections.md)
and the privacy policy ([iskra.foo/privacy](https://iskra.foo/privacy)). Re-check them when the app starts sending
anything new off the phone (for example phone push through a relay).

## How Iskra maps onto the form

Play asks what data "your app" **collects** (sends off the device) and **shares** (transfers to a third party).

- **The app sends data to one kind of place only: the Iskra servers the person joins.** Each server is run by its
  owner (a friend, or the person themselves), not by us. There is no default server and no central Iskra service;
  the app contains no analytics, ads, crash reporting, Firebase or Google Play services
  (`mobile/android/app/build.gradle`: AndroidX and Capacitor only). Notifications come straight from the servers
  while the app is open; the Android app uses no push service.
- **We declare that data as collected anyway.** Play's definition of collection is "transmitted off the user's
  device", not "received by the developer", and From a Spark runs servers too (chat.iskra.foo), so someone joining
  those sends data to us. Declaring it is the honest reading; the privacy policy explains that each server's owner is
  responsible for their server.
- **Not shared.** Sending messages and files to the server you chose to join, for the people on it to see, is a
  transfer "based on a specific user-initiated action, where the user reasonably expects the data to be shared",
  which Play exempts from "sharing". Nothing goes to advertisers, data brokers or analytics.
- **End-to-end encrypted content is left out.** Play exempts data sent with end-to-end encryption (unreadable by
  anyone but sender and recipient, including the developer and the server): DMs, group chats, their files, voice
  messages and calls, encrypted channels and synced settings. Server channels are *not* end-to-end encrypted, so
  their content is declared below.
- **Done on the phone only, so not collected:** account private keys, noise removal, captions, camera effects,
  clips, Catch up summaries, the QR scanner. "Playing X" activity is desktop-only and not in the Android app.
- **IP addresses:** every server sees the phone's IP while connected (it has to). Iskra's server stores no IP
  addresses in its database by default (the security log records them only if the owner turns that on) and never
  derives a location from them, so no "Location" type applies.

## Section 1: Data collection and security

| Question | Answer | Why |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | Names, account IDs and server-channel content are sent to the servers you join |
| Is all of the user data collected by your app encrypted in transit? | **Owner decision, see below.** Recommended: **No** until checked | Servers open to the internet always use HTTPS/WSS (automatic certificates). A server on a home network can run without HTTPS, and the Android app loads from `http://localhost` precisely so such LAN servers keep working (`mobile/capacitor.config.ts`). End-to-end encrypted data is encrypted either way |
| Which of the following methods of account creation does your app support? | **Other**: "An account is a cryptographic key created on the device. No username, email or password." | `client/src/core/identity.ts`; there is no sign-up with us |
| Account deletion URL | **https://iskra.foo/delete-account** | In-app: Settings → Account → Delete my account (every server at once, then wipes the device) |
| Do you provide a way for users to request that their data is deleted (without deleting the account)? | **Yes** | People delete their own messages, files, profile fields and devices in the app, and can leave a server; the delete-account page also covers servers we run (email spark@iskra.foo) |

**Encrypted in transit, to decide:** Play only lets you say Yes if *all* collected data is encrypted in transit. Test
on a phone with the Play build: join a LAN server that has no HTTPS (`http://192.168.x.x:47070`). If it connects,
answer **No** (honest; the listing then shows "Data isn't encrypted"). If Android blocks it (cleartext traffic is off
by default for apps targeting API 28+, and `capacitor.config.ts` doesn't set `server.cleartext`), every server the
app can reach uses HTTPS and the answer is **Yes**; then also update mobile/README.md, which says LAN servers without
HTTPS work.

## Section 2: Data types

Mark each type below as **Collected: Yes, Shared: No**. All are **not processed ephemerally** (they're stored on the
server) unless noted. Purpose for every type: **App functionality**; for Name and User IDs also **Account management**.

| Category → type | Collected | Required or optional | What it is in Iskra |
|---|---|---|---|
| Personal info → **Name** | Yes | Required | The display name you pick (and per-server nicknames) |
| Personal info → **User IDs** | Yes | Required | Your account's public key and device public keys; the server's key log |
| Personal info → **Other info** | Yes | Optional | Profile fields: bio, pronouns, custom status, profile colour, profile page |
| Personal info → Email, Address, Phone, Race, Political/religious beliefs, Sexual orientation | No | | Never asked for |
| Financial info (all) | No | | No purchases or payments (tips are hidden in the phone apps) |
| Health and fitness (all) | No | | |
| Messages → **Other in-app messages** | Yes | Required | Messages in server channels, threads, forums and voice-channel chats (DMs and group chats are end-to-end encrypted and not counted) |
| Messages → Emails, SMS or MMS | No | | |
| Photos and videos → **Photos** | Yes | Optional | Avatars, images you post in server channels, custom emoji and stickers |
| Photos and videos → **Videos** | Yes | Optional | Videos you upload to server channels or for a watch party. Camera video in voice channels passes through the server's voice service live and isn't stored |
| Audio → **Voice or sound recordings** | Yes | Optional | Voice messages in server channels. Live voice in voice channels passes through the server's voice service and isn't recorded |
| Audio → **Music files** | No | | |
| Audio → **Other audio files** | Yes | Optional | Soundboard sounds you add |
| Files and docs | Yes | Optional | Files you upload to server channels; docs pages |
| Calendar → Calendar events | No | | Iskra's events live on the server; "Add to calendar" only hands a file to your own calendar app |
| Contacts | No | | The app never reads the phone's contacts. Friends are Iskra accounts on your servers |
| App activity → **Other user-generated content** | Yes | Optional | Reactions, polls and votes, pins, events you create or mark Interested, server rules you accept, reports you file |
| App activity → **Other actions** | Yes | Required | Presence (online, idle, in voice: kept in memory only, so tick **processed ephemerally**), notification levels and your block list on each server |
| App activity → App interactions, In-app search history, Installed apps | No | | Searches run on the server and aren't stored; no usage tracking; the app never lists installed apps |
| Web browsing | No | | Link previews are fetched by the server, not the phone |
| App info and performance (crash logs, diagnostics, other) | No | | No crash reporting or analytics |
| Device or other IDs | Yes | Required | The per-device public key Iskra creates (an app-instance identifier). No Android ID, advertising ID or IMEI |
| Location (approximate, precise) | No | | Never asked for or derived |

If the form asks for a purpose per type: Name and User IDs → App functionality, Account management. Everything else
→ App functionality only. Nothing is used for analytics, advertising, personalization or fraud prevention.

## Section 3: Security practices shown on the listing

- Data is encrypted in transit: see the decision above.
- You can request that data be deleted: **Yes** (in the app, and https://iskra.foo/delete-account).
- Committed to Play Families Policy: **No** (Iskra isn't for children under 13).
- Independent security review: **No** (don't tick; the ASVS self-assessment in docs/compliance isn't an independent
  review).

## Where each answer comes from

| Fact | Source |
|---|---|
| Only the joined servers are contacted; no analytics, ads, crash reports, Google services | docs/privacy-connections.md, `mobile/android/app/build.gradle`, privacy policy §8 |
| What a server stores | privacy policy §3, `server/src/Iskra.Server/Storage/` |
| End-to-end encrypted DMs, groups, calls, encrypted channels, synced settings | docs/security.md, privacy policy §2 and §4 |
| No IP addresses stored by default | privacy policy §3, `SecurityLog` (`LoggedIp`) |
| No push on Android | mobile/README.md, privacy policy §7 |
| Account deletion | `site/delete-account.html`, Settings → Account |
