// The app shell (English): the member list's header, the recovery-key reminder in the me bar. Keep in step with ../sv/shell.ts.
export const shell = {
  members: {
    title: 'Members',
    count_one: '{{count}} member',
    count_other: '{{count}} members',
    search: 'Search members',
    searchPlaceholder: 'Find someone',
    clear: 'Clear search',
    close: 'Close members',
    none: 'No one called "{{query}}" here.',
  },
  recovery: {
    row: 'Save your recovery key',
    notSaved: 'Recovery key not saved yet',
  },
} as const
