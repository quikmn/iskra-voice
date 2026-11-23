import type { Messages } from '../types'

export const share: Messages['share'] = {
  title: 'Compartilhar em…',
  preview: 'O que você está compartilhando',
  message: 'Mensagem',
  messagePlaceholder: 'Adicione uma mensagem (opcional)',
  skipped_one: 'Não foi possível adicionar {{count}} arquivo (grande demais, ou mais de 10).',
  skipped_other: 'Não foi possível adicionar {{count}} arquivos (grandes demais, ou mais de 10).',
  sendToLabel: 'Enviar para',
  search: 'Buscar canais, pessoas e grupos',
  places: 'Lugares para compartilhar',
  recent: 'Recentes',
  everywhere: 'Todos',
  nothing: 'Nada encontrado.',
  loading: 'Conectando aos seus servidores…',
  noServers: 'Entre em um servidor primeiro, depois você pode compartilhar aqui.',
  dm: 'Mensagem direta',
  group: 'Grupo · {{server}}',
  sendTo: 'Enviar para {{target}}',
  sending: 'Enviando… {{percent}}',
  errors: {
    empty: 'Não há nada para enviar.',
    offline: 'Esse servidor não está conectado agora. Tente de novo em instantes.',
    tooBig: '{{name}} é maior do que este servidor permite ({{max}}).',
    fileGone: '{{name}} não está mais disponível. Compartilhe de novo.',
  },
}
