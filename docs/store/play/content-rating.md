# Google Play: Content rating (IARC questionnaire)

Play Console → Iskra → **Policy and programs → App content → Content ratings → Start questionnaire**. The wording of
the questions changes now and then; answer by meaning.

## Before the questions

| Field | Answer |
|---|---|
| Email address for IARC | spark@iskra.foo (IARC sends the rating certificate there) |
| Category | **Social or communication** ("Social Networking, Forums, Blogs and User-Generated Content Sharing" / "Communication", whichever the form offers). Not "Game", not "Reference, news or educational" |

## The app's own content

Iskra ships no content of its own: no feed, no media library, no public directory of servers, no default server.
Everything a person sees comes from the servers they were invited to, written by the people on them. So every
question about the app's *own* content is **No**:

| Question (by topic) | Answer |
|---|---|
| Violence, blood, gore | No |
| Fear, horror | No |
| Sexuality, nudity | No |
| Offensive or crude language, crude humour | No |
| Controlled substances (drugs, alcohol, tobacco) | No |
| Gambling, simulated gambling, real-money gaming | No |
| Discrimination, hate | No |
| Does the app contain a web browser or search engine? | No (links open in the phone's browser; search only searches messages on your servers) |
| Is the app primarily a news or educational product? | No |

## Interactive features

| Question | Answer | Why |
|---|---|---|
| Can users interact or communicate with each other (chat, voice, messages)? | **Yes** | Text, voice and video between people on the same server, DMs and group chats |
| Does the app allow users to share user-generated content (images, video, text, audio)? | **Yes** | Posts, files, images, voice messages, custom emoji, stickers, sounds, profile pages |
| Is the user-generated content moderated? | **Yes, by the community**: answer "moderated" only if the form allows "by users/community"; otherwise answer the plain interaction questions and leave moderation out | We don't see or moderate servers. Each server's owner and moderators have moderation tools: delete messages, timeouts, kick, ban, slow mode, AutoMod (blocked words and links), reports to moderators, an activity log, blocking people. Our Terms of Use (iskra.foo/terms) set the rules and give spark@iskra.foo for safety concerns |
| Does the app share the user's current physical location with other users? | **No** | Never collected |
| Can users purchase digital goods? | **No** | No purchases; tips are hidden in the phone apps |
| Does the app contain ads? | **No** | |
| Can users exchange personal info such as phone numbers? | Answer **Yes** if asked (people can type anything into a chat) | |
| Unrestricted internet access | **No** | The app only talks to the servers the person joins (embeds load only on tap) |

## What to expect

Communication apps without their own mature content usually get a low age rating with the interactive elements
**"Users Interact"** (and "Shares Info" where people can share personal details), e.g. ESRB Teen or Everyone with
"Users Interact", PEGI 12 or 3 with the same notice. Some regions rate apps with open chat higher. Whatever comes back,
Iskra's own Terms say 13 or older (see [app-content.md](app-content.md), target audience); a lower store rating doesn't
change that.

If a rating ever looks wrong, re-do the questionnaire rather than appealing: the answers above are the facts.
