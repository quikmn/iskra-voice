import type { Messages } from '../types'

export const shell: Messages['shell'] = {
  members: {
    title: 'Membros',
    count_one: '{{count}} membro',
    count_other: '{{count}} membros',
    search: 'Buscar membros',
    searchPlaceholder: 'Encontrar alguém',
    clear: 'Limpar busca',
    close: 'Fechar membros',
    none: 'Ninguém com o nome “{{query}}” por aqui.',
  },
  recovery: {
    row: 'Salve sua chave de recuperação',
    notSaved: 'Chave de recuperação ainda não salva',
  },
}
