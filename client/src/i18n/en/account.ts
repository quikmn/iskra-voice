// account text (English): the first-run choice and signing out. Keep in step with ../sv/account.ts.
export const account = {
  welcome: {
    lead: 'Voice and text chat with your friends, on servers you own.',
    question: 'Have you used Iskra before?',
    new: 'I’m new to Iskra',
    newHint: 'Pick a name and you’re in. No email, no password.',
    existing: 'I already use Iskra on another device',
    existingHint: 'Link this device to your account, or use your recovery key. Your servers, friends and messages come along.',
    back: 'Back',
  },
  signOut: {
    button: 'Sign out of this device',
    hint: 'Removes your account from this device only.',
    title: 'Sign out of this device',
    intro: 'This removes your account’s keys, messages and settings from this device, and this device from your account. Then Iskra starts fresh here.',
    otherDevices_one: 'Your account stays on your other device, so nothing is lost.',
    otherDevices_other: 'Your account stays on your {{count}} other devices, so nothing is lost.',
    onlyDevice: 'This is the only device with your account. To use it again, you’ll need your recovery key.',
    dangerTitle: 'You’ll lose this account for good',
    danger: 'This is your only device and you haven’t saved your recovery key. If you sign out now, nobody can bring this account back: not you, and not a server owner.',
    saveFirst: 'Save recovery key first',
    understand: 'I understand this account will be gone for good',
    leave: 'Also leave my servers',
    leaveHint: 'Your account leaves them on every device: you disappear from their member lists and need a new invite to come back. You stay in servers you own.',
    confirm: 'Sign out',
    busy: 'Signing out…',
  },
} as const
