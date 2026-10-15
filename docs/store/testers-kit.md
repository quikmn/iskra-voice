# Tester kit: texts to paste once

For the Google Play closed test (12 testers for 14 days, needed before production) and the TestFlight public link.
Replace `{{PLAY_OPT_IN}}` with the closed test's opt-in link (Play Console → Testing → Closed testing → the track →
**Testers** → *How testers join your test* → **Copy link**) and `{{REVIEW_INVITE}}` with the review server's
never-expiring invite (the same link as the `REVIEW_INVITE_URL` variable). The public guide for testers is
[docs/testers.md](../testers.md); it has the same placeholders.

## For the paid tester service

**App name:** Iskra

**Opt-in link (Android):** {{PLAY_OPT_IN}}

**Short description** (one line):

> Free voice and text chat for friend groups, on a server you own. No ads, no tracking.

**App description:**

> Iskra is a free app for voice and text chat with friends, like a small Discord that you or a friend runs yourselves.
> It has text channels, voice channels, direct messages, forums, polls, threads, events and more. Messages and voice go
> to the server you join, not to us. There are no ads and no tracking, and you sign in without an email or password.
>
> For this test you join our test server, "Iskra Review", with an invite link. It has a short guide and a channel for
> each thing to try.

**Instructions for testers** (paste as the task description):

> Thank you for testing Iskra! The full guide: https://github.com/quikmn/iskra-voice/blob/main/docs/testers.md
>
> **Day 1 (about 10 minutes)**
> 1. Join the test with the opt-in link: {{PLAY_OPT_IN}} Then install **Iskra** from Google Play.
> 2. Open this invite link on your phone: {{REVIEW_INVITE}} Choose "I'm new to Iskra", pick a name and tap Join.
> 3. Read the five rules and tap "I agree". Save your recovery key when the app asks.
> 4. Say hi in **#introductions** (first name and phone model).
> 5. Open **testing-guide** and do the 10-minute tour.
>
> **Every day for 14 days (2–5 minutes)**
> - Open Iskra and read **#announcements**.
> - Try one thing from the guide: a voice channel, a poll, a thread, a direct message, translation, a whiteboard…
> - Send a message or a reaction, so we know the app works for you that day.
> - Found a problem? Tap your name at the bottom of the channel list → **Report a bug**. One problem per report; a
>   screenshot helps.
>
> **Please**
> - Keep the app installed and stay in the test for all 14 days.
> - Don't post personal data (phone number, address, passwords) on the server or in screenshots.
> - Write in any language. Short notes are perfect.

## Google Play closed test: "Feedback URL or email address"

Play Console → Testing → Closed testing → the track → **Testers** → *Feedback URL or email address*:

```
https://github.com/quikmn/iskra-voice/blob/main/docs/testers.md#4-report-a-bug
```

(It explains the in-app **Report a bug**, which sends the version and logs with the report. Use
`spark@iskra.foo` instead if Play wants an email address.)

## TestFlight: "What to test"

Nothing to paste: every release sets "What to test" (English and Swedish) from the release notes, and the test
information (description, feedback email, privacy and marketing URLs) from [appstore](appstore), with
`scripts/appstore.mjs` (see [README.md](README.md)). For the external group's first Beta App Review, Apple also shows
the review notes in [appstore/review-notes.txt](appstore/review-notes.txt).

The public link for iPhone testers is https://testflight.apple.com/join/r4tMgn3D; point them to the same guide.

## On the review server

The server's own guide comes from `server/templates/review.json` (welcome messages, a testing guide with a Start here
page, a topic on every channel, rules testers agree to, a feedback forum). Make the testers' invite with the role
**Trusted**: on the review server, Trusted can split voice channels into teams but can't @everyone.

Bug reports from every tester's app go to the bug inbox on chat.iskra.foo: `server/templates/bug-inbox.json` adds the
admin-only `#bug-reports` channel and turns the inbox on.
