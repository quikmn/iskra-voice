import type { Messages } from '../types'

export const dmRequests: Messages['dmRequests'] = {
  title: 'Pedidos de mensagem',
  badge_one: '{{count}} pedido de mensagem',
  badge_other: '{{count}} pedidos de mensagem',
  empty: 'Nenhum pedido novo.',
  ignoredCount_one: 'Ignorados ({{count}})',
  ignoredCount_other: 'Ignorados ({{count}})',
  bar: '{{name}} quer conversar com você.',
  ignoredBar: 'Você ignorou o pedido de {{name}}.',
  barHint: 'A pessoa não sabe se você viu. Links e arquivos ficam ocultos até você aceitar.',
  accept: 'Aceitar',
  ignore: 'Ignorar',
  block: 'Bloquear',
  filesHidden_one: '{{count}} arquivo, oculto até você aceitar',
  filesHidden_other: '{{count}} arquivos, ocultos até você aceitar',
  settingTitle: 'Quem pode me enviar mensagens',
  refused: '{{server}} não aceitou esta escolha e mantém a anterior: {{reason}}',
  settingHint: 'Vale em todos os servidores em que você está. Quem já conversou com você sempre pode escrever, e você ainda pode iniciar uma conversa com qualquer pessoa.',
  who: {
    anyone: 'Qualquer pessoa dos meus servidores',
    requests: 'Qualquer pessoa, como pedido de mensagem',
    known: 'Pessoas com quem já conversei e a equipe do servidor',
    nobody: 'Só pessoas com quem já conversei',
  },
  whoHint: {
    anyone: 'Mensagens novas vão direto para suas mensagens diretas.',
    requests: 'Pessoas novas caem em Pedidos de mensagem, sem notificações, até você aceitar. Moderadores e admins passam direto.',
    known: 'Outras pessoas não podem iniciar uma conversa com você. Moderadores e admins podem.',
    nobody: 'Ninguém novo pode iniciar uma conversa com você, nem a equipe.',
  },
}
