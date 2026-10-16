// Join-to-create voice rooms (English): lobbies in the channel list, the room settings dialog, the host's menu items.
// Keep in step with ../sv/rooms.ts.
export const rooms = {
  lobby: {
    join: 'Join {{name}} to get a room of your own',
    badge: 'Lobby',
    badgeHint: 'Joining makes a voice room of your own, right under this one.',
  },
  room: {
    locked: 'Locked',
    lockedHint: '{{name}} is locked: only people the host invites can join.',
    host: 'Host',
    hostOf: '{{name}} hosts this room',
    yours: 'Your room',
  },
  settings: {
    title: 'Room settings',
    menu: 'Room settings…',
    button: 'Your room',
    name: 'Name',
    nameHint: 'Shown as {{slug}}.',
    locked: 'Lock the room',
    lockedHint: 'Only you, people you invite and moderators can join while it is locked. Nobody inside is removed.',
    invite: 'Who can join while it is locked',
    invited: 'Invited',
    search: 'Search members',
    nobodyMatches: 'Nobody matches.',
    add: 'Invite',
    remove: 'Uninvite',
    emptiesHint: 'The room is removed about 30 seconds after the last person leaves.',
  },
  userMenu: {
    invite: 'Invite to {{room}}',
    uninvite: 'Uninvite from {{room}}',
  },
}
