// End-to-end encrypted channels (English). Keep in step with ../sv/e2ee.ts.
export const e2ee = {
  badge: 'End-to-end encrypted',
  create: {
    toggle: 'End-to-end encrypted',
    hint: "Only the people who can see this channel can read it, on their own devices. The server stores messages it can't read.",
    limits: "Made for small private channels (up to {{max}} people). New members can't read messages from before they joined, search only works on your device, and webhooks, bots, polls, stickers, GIFs and forwarding aren't available. This can't be turned off later.",
    kinds: 'Only text and voice channels can be encrypted.',
    count_one: '{{count}} person will be able to read it.',
    count_other: '{{count}} people will be able to read it.',
    tooMany: '{{count}} people could see this channel, and an encrypted channel fits {{max}}. Choose a higher "who can see".',
  },
  panel: {
    open: 'Encryption',
    title: 'Encryption',
    intro: 'Messages here are encrypted on your device. Only these people’s devices hold the key:',
    you: 'you',
    version: 'Key version {{version}}',
    safetyNumber: 'Safety number',
    warning: 'Key warning',
    full: 'More people can see this channel than fit. The rest wait until there is room.',
    rekey: 'Hand out a new key',
    rekeyHint: 'Do this if a device that could read this channel was lost. Everyone in it gets a new key automatically.',
    rekeyDone: 'A new key was handed out.',
    metadata: 'The server still sees who is in the channel, who writes and when, how big messages are, reactions, pins and replies.',
    problem: "This channel's encryption couldn't be checked: {{problem}}",
  },
  waiting: "Waiting for someone in this channel to share its key with you. It happens automatically when one of them is online.",
  message: {
    pending: 'Decrypting…',
    noKey: "Encrypted before you could read this channel (or before this device was added), so it can't be read here.",
    error: "This message couldn't be decrypted.",
  },
  search: {
    local: 'Encrypted channels are searched on this device only, in the messages it has decrypted.',
  },
  report: {
    share: 'Share what this message says with the moderators',
    shareHint: "Only members can read this channel, so moderators see the text you share and can't check it against the server.",
  },
  thread: {
    title: 'Thread',
    noName: 'Threads in encrypted channels have no name, so the server learns nothing about them.',
  },
  voice: {
    noKey: "You can't join yet: this device doesn't have the channel's key.",
  },
  errors: {
    noKey: "This device doesn't have this channel's key yet.",
    stickers: "Stickers and GIFs can't be sent in encrypted channels yet.",
    missingFile: 'An attachment is missing. Attach it again.',
    notReady: 'This channel isn’t ready yet.',
    offline: "This server isn't connected right now.",
    tooMany: 'At most 50 people can be in an encrypted channel.',
    notEncrypted: 'Not an encrypted channel.',
  },
} as const
