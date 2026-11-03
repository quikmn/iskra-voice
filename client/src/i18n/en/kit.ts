// The shared UI kit (ui/kit) and the settings frame (English). Keep in step with ../sv/kit.ts.
export const kit = {
  unsaved: 'You have unsaved changes.',
  saveChanges: 'Save changes',
  nameRequired: "Your name can't be empty.",
  // My settings: the nav's groups.
  myGroups: {
    you: 'You',
    app: 'App',
    privacy: 'Privacy & safety',
  },
  // The member sheet's moderation tabs.
  modTabs: {
    label: 'Moderation tools',
    timeout: 'Timeout',
    warn: 'Warn',
    notes: 'Notes',
    history: 'History',
  },
} as const
