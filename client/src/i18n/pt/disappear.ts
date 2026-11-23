import type { Messages } from '../types'

export const disappear: Messages['disappear'] = {
  title: 'Mensagens temporárias',
  timers: {
    '0': 'Desativado',
    '300': '5 minutos',
    '3600': '1 hora',
    '28800': '8 horas',
    '86400': '1 dia',
    '604800': '7 dias',
    '2419200': '4 semanas',
  },
  short: {
    '300': '5min',
    '3600': '1h',
    '28800': '8h',
    '86400': '1d',
    '604800': '7d',
    '2419200': '4sem',
  },
  button: 'Mensagens temporárias: {{state}}',
  intro: {
    dm: 'As mensagens novas desta conversa somem para vocês dois quando o tempo acaba.',
    group: 'As mensagens novas deste grupo somem para todo mundo quando o tempo acaba.',
    channel: 'As mensagens novas deste canal somem para todo mundo quando o tempo acaba.',
  },
  newOnly: 'Mudar o tempo só vale para as mensagens enviadas depois da mudança.',
  deleted: 'Quando o tempo acaba, as mensagens e seus arquivos são excluídos do servidor e dos dispositivos de todo mundo. Os backups do servidor nunca incluem essas mensagens.',
  honest: 'As pessoas ainda podem fazer capturas de tela, copiar o texto ou salvar arquivos antes de uma mensagem sumir.',
  managersOnly: 'Só quem pode gerenciar canais pode mudar isto.',
  saving: 'Salvando…',
  line: {
    on: '{{name}} definiu que as mensagens novas somem depois de {{duration}}.',
    off: '{{name}} desativou as mensagens temporárias.',
    onYou: 'Você definiu que as mensagens novas somem depois de {{duration}}.',
    offYou: 'Você desativou as mensagens temporárias.',
  },
  expires: 'Some {{time}}',
  fallback: {
    on: 'Defini que as mensagens novas somem depois de {{duration}}. (Atualize o Iskra para ver o tempo.)',
    off: 'Desativei as mensagens temporárias.',
  },
}
