import type { Messages } from '../types'

export const afk: Messages['afk'] = {
  forced: 'Canal AFK: microfone e áudio desativados',
  forcedHint: 'No canal AFK, o servidor desativa seu microfone e você não ouve ninguém. Entre em outro canal de voz para voltar a falar.',
  badge: 'AFK',
  channelHint: 'Canal AFK',
  participantForced: 'Microfone e áudio desativados (canal AFK)',
  movedTitle: 'Você foi para {{channel}}',
  movedBody: 'Você ficou {{minutes}} minutos sem atividade na voz, então {{server}} moveu você para o canal AFK. Entre em qualquer canal de voz para voltar.',
  movedBodyShort: 'Você ficou sem atividade na voz, então {{server}} moveu você para o canal AFK. Entre em qualquer canal de voz para voltar.',
  settings: {
    intro: 'Dê um lugar para quem se afasta. Quem fica um tempo sem atividade em um canal de voz vai para o canal AFK, onde o microfone e o áudio ficam desativados.',
    channel: 'Canal AFK',
    none: 'Sem canal AFK',
    create: 'Criar canal AFK',
    defaultName: 'AFK',
    idle: 'Mover quem está sem atividade depois de',
    minutes: '{{n}} minutos',
    never: 'Nunca',
    idleHint: 'Sem atividade quer dizer sem digitar, clicar nem tocar (em qualquer lugar do computador no app para computador; no Iskra, na web e no celular) e sem falar, durante todo o tempo. Quem está falando nunca é movido.',
    canTalk: 'Podem falar aqui',
    canTalkHint: 'O servidor desativa o microfone e o áudio de todas as outras pessoas no canal AFK, sejam quais forem as configurações delas.',
    baseRoles: 'Cargos integrados',
    customRoles: 'Cargos',
    saved: 'Salvo',
  },
}
