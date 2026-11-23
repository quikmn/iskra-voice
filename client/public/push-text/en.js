// Push notification texts in English: the reference every other file in this folder follows (same names, same
// {{variables}}). The worker never loads this one: the server writes its pushes in English already.
// A text that counts something can be one string, or its plural forms: { one: '…', few: '…', many: '…', other: '…' }.
self.ISKRA_PUSH_TEXT = {
  // Shown when a push can't be read.
  generic: 'You have new activity.',
  title: {
    mention: '{{name}} in #{{channel}}',
    reply: '{{name}} replied in #{{channel}}',
    encrypted: 'New message in #{{channel}}',
    dm: 'New message from {{name}}',
    calling: '{{name}} is calling',
    groupCall: '{{name}} started a group call',
    reminder: 'Reminder',
    scheduledFailed: "Your scheduled message wasn't sent",
    eventLive: '{{title}} is starting now',
    eventSoon: 'Starting soon: {{title}}',
    lfgJoined: '{{name}} joined your group for {{game}}',
    lfgFull: 'Your group for {{game}} is full',
    lfgPosted: '{{name}} is looking for {{slots}} for {{game}}',
    digest: 'While it was quiet',
  },
  body: {
    openToRead: 'Open Iskra to read it.',
    groupOpenToRead: 'In a group. Open Iskra to read it.',
    attachment: 'Sent an attachment',
    tapToAnswer: 'Tap to answer.',
    tapToJoin: 'Tap to join.',
    reminderGeneric: 'You asked to be reminded about a message.',
    happeningChannel: 'Happening in {{channel}}',
    happeningVoice: 'Happening in voice',
    happeningAt: 'Happening {{place}}',
    happening: 'Happening now',
    inMinutesChannel: 'In {{minutes}} min, in {{channel}}',
    inMinutesVoice: 'In {{minutes}} min, in voice',
    inMinutesAt: 'In {{minutes}} min, {{place}}',
    inMinutes: 'In {{minutes}} min',
    lfgIn: 'In #{{channel}}',
    lfgTime: 'Time to play!',
  },
  // Several unread at once ({{count}} is 2 or more).
  dmCount: '{{count}} new messages from {{from}}',
  groupCount: '{{count}} new messages in a group chat',
  // Added after a message's text when more arrived ({{n}} is 1 or more). Keep the space in front.
  more: ' (+{{n}} more)',
  // The quiet hours summary, built from its counts and joined with commas: "2 mentions, 1 message".
  digest: {
    mentions: { one: '{{n}} mention', other: '{{n}} mentions' },
    messages: { one: '{{n}} message', other: '{{n}} messages' },
    keywords: { one: '{{n}} alert word', other: '{{n}} alert words' },
    follows: { one: '{{n}} post by someone you follow', other: '{{n}} posts by people you follow' },
    events: { one: '{{n}} event', other: '{{n}} events' },
    reminders: { one: '{{n}} reminder', other: '{{n}} reminders' },
  },
}
