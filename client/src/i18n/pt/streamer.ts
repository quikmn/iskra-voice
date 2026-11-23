import type { Messages } from '../types'

export const streamer: Messages['streamer'] = {
  title: 'Modo streamer',
  pill: 'Modo streamer',
  pillHint: 'O modo streamer está ativado: links de convite, IDs e prévias ficam ocultos, e as notificações ficam em silêncio. Desative em Minhas configurações ou no seu menu de status.',
  switch: 'Modo streamer',
  switchHint: 'Para quando sua tela está em uma live: oculta links e códigos de convite, IDs de conta e números de segurança, endereços de e-mail nos perfis e prévias de mensagens, e deixa notificações e sons em silêncio. Acompanha sua conta nos outros dispositivos.',
  on: 'Ativado',
  off: 'Desativado',
  autoTitle: 'Ativar sozinho',
  auto: 'Enquanto um programa da minha lista abaixo estiver aberto',
  autoHint: 'Adicione o OBS, o Streamlabs ou o que você usa para transmitir à lista de programas, e o modo streamer se ativa enquanto o programa está aberto e se desativa quando ele fecha. Só neste computador, e só os programas que você adicionou são procurados.',
  autoNow: 'Um programa da sua lista está aberto: o modo streamer está ativado.',
  autoDesktopOnly: 'O app para computador também pode ativar o modo sozinho enquanto seu programa de transmissão está aberto:',
  hidden: 'Oculto no modo streamer',
  hiddenShort: 'Oculto',
  menu: {
    on: 'O modo streamer está ativado',
    off: 'Modo streamer',
    turnOff: 'Desativar',
    turnOn: 'Ativar',
    autoOn: 'Ativado enquanto seu programa de transmissão está aberto',
  },
}
