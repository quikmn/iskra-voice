// Disappearing messages (English). Keep in step with ../sv/disappear.ts.
export const disappear = {
  title: 'Disappearing messages',
  timers: {
    '0': 'Off',
    '300': '5 minutes',
    '3600': '1 hour',
    '28800': '8 hours',
    '86400': '1 day',
    '604800': '7 days',
    '2419200': '4 weeks',
  },
  short: {
    '300': '5m',
    '3600': '1h',
    '28800': '8h',
    '86400': '1d',
    '604800': '7d',
    '2419200': '4w',
  },
  button: 'Disappearing messages: {{state}}',
  intro: {
    dm: 'New messages in this conversation disappear for both of you once the time is up.',
    group: 'New messages in this group disappear for everyone once the time is up.',
    channel: 'New messages in this channel disappear for everyone once the time is up.',
  },
  newOnly: 'Changing the timer only affects messages sent after the change.',
  deleted: 'When their time is up, messages and their files are deleted from the server and from everyone’s devices. Server backups never include them.',
  honest: 'People can still take screenshots, copy text or save files before a message disappears.',
  managersOnly: 'Only people who can manage channels can change this.',
  saving: 'Saving…',
  line: {
    on: '{{name}} set new messages to disappear after {{duration}}.',
    off: '{{name}} turned off disappearing messages.',
    onYou: 'You set new messages to disappear after {{duration}}.',
    offYou: 'You turned off disappearing messages.',
  },
  expires: 'Disappears {{time}}',
  fallback: {
    on: 'I set new messages to disappear after {{duration}}. (Update Iskra to see the timer.)',
    off: 'I turned off disappearing messages.',
  },
}
