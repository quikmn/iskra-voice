import type { Messages } from '../types'

export const sounds: Messages['sounds'] = {
  heading: 'Sons',
  names: {
    classic: 'Clássico',
    chime: 'Carrilhão',
    pop: 'Pop',
    bell: 'Sino',
    droplet: 'Gota',
    marimba: 'Marimba',
    custom: 'Seu próprio som',
    none: 'Sem som',
  },
  kinds: {
    message: 'Mensagens',
    mention: 'Menções e respostas',
    dm: 'Mensagens diretas',
  },
  preview: 'Tocar',
  previewOf: 'Tocar {{sound}}',
  inherit: 'Igual ao seu ({{sound}})',
  customMissing: 'Seu próprio som (toca Clássico neste dispositivo)',
  syncHint: 'Suas escolhas acompanham você nos outros dispositivos. Um servidor ou canal pode ter um som próprio: escolha no menu dele.',
  menuRow: 'Som',
  menuTitle: 'Som de {{place}}',
  yourDefault: 'Seu som',
  serverDefault: 'Som do servidor',
  custom: {
    heading: 'Seu próprio som',
    upload: 'Fazer upload de um som',
    replace: 'Trocar',
    remove: 'Remover',
    current: '{{name}} ({{seconds}} s)',
    hint: 'Um arquivo de som curto: até 4 segundos e 1 MB. Ele fica neste dispositivo e nunca é enviado; seus outros dispositivos tocam Clássico no lugar.',
    problems: {
      notAudio: 'Isso não é um arquivo de som.',
      tooBig: 'Esse arquivo é grande demais. Escolha um de até 1 MB.',
      tooLong: 'Esse som é longo demais. Escolha um de até 4 segundos.',
      empty: 'Esse som está em silêncio.',
      unreadable: 'Não foi possível tocar esse som aqui. Tente um arquivo MP3, Ogg ou WAV.',
    },
  },
}
