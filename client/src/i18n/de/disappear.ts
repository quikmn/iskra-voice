import type { Messages } from '../types'

export const disappear: Messages['disappear'] = {
  title: 'Selbstlöschende Nachrichten',
  timers: {
    '0': 'Aus',
    '300': '5 Minuten',
    '3600': '1 Stunde',
    '28800': '8 Stunden',
    '86400': '1 Tag',
    '604800': '7 Tage',
    '2419200': '4 Wochen',
  },
  short: {
    '300': '5 Min.',
    '3600': '1 Std.',
    '28800': '8 Std.',
    '86400': '1 T.',
    '604800': '7 T.',
    '2419200': '4 Wo.',
  },
  button: 'Selbstlöschende Nachrichten: {{state}}',
  intro: {
    dm: 'Neue Nachrichten in dieser Unterhaltung verschwinden für euch beide, sobald die Zeit um ist.',
    group: 'Neue Nachrichten in dieser Gruppe verschwinden für alle, sobald die Zeit um ist.',
    channel: 'Neue Nachrichten in diesem Kanal verschwinden für alle, sobald die Zeit um ist.',
  },
  newOnly: 'Eine neue Zeit gilt nur für Nachrichten, die danach gesendet werden.',
  deleted: 'Wenn ihre Zeit um ist, werden Nachrichten und ihre Dateien vom Server und von allen Geräten gelöscht. In Server-Backups sind sie nie enthalten.',
  honest: 'Andere können trotzdem Screenshots machen, Text kopieren oder Dateien speichern, bevor eine Nachricht verschwindet.',
  managersOnly: 'Das kann nur ändern, wer Kanäle verwalten darf.',
  saving: 'Speichert…',
  line: {
    on: '{{name}} hat eingestellt, dass neue Nachrichten nach {{duration}} verschwinden.',
    off: '{{name}} hat selbstlöschende Nachrichten ausgeschaltet.',
    onYou: 'Du hast eingestellt, dass neue Nachrichten nach {{duration}} verschwinden.',
    offYou: 'Du hast selbstlöschende Nachrichten ausgeschaltet.',
  },
  expires: 'Verschwindet {{time}}',
  fallback: {
    on: 'Ich habe eingestellt, dass neue Nachrichten nach {{duration}} verschwinden. (Aktualisiere Iskra, um die Zeit zu sehen.)',
    off: 'Ich habe selbstlöschende Nachrichten ausgeschaltet.',
  },
}
