import type { Messages } from '../types'

export const account: Messages['account'] = {
  welcome: {
    lead: 'Chat de voz e texto com seus amigos, em servidores que são seus.',
    question: 'Você já usou o Iskra antes?',
    step: 'Etapa {{step}} de {{of}}',
    new: 'É minha primeira vez no Iskra',
    newHint: 'Escolha um nome e pronto. Sem e-mail, sem senha.',
    existing: 'Já uso o Iskra em outro dispositivo',
    existingHint: 'Vincule este dispositivo à sua conta, ou use sua chave de recuperação. Seus servidores, amigos e mensagens vêm junto.',
    back: 'Voltar',
    invitedTwice: 'Já entrou por outro dispositivo ou navegador? Escolha “Já uso o Iskra”. Uma conta nova aparece como uma pessoa nova no servidor.',
  },
  signOut: {
    button: 'Sair da conta neste dispositivo',
    hint: 'Remove sua conta só deste dispositivo.',
    title: 'Sair da conta neste dispositivo',
    intro: 'Isto remove as chaves, as mensagens e as configurações da sua conta deste dispositivo, e este dispositivo da sua conta. Depois, o Iskra começa do zero aqui.',
    otherDevices_one: 'Sua conta continua em {{count}} outro dispositivo, então nada se perde.',
    otherDevices_other: 'Sua conta continua nos seus {{count}} outros dispositivos, então nada se perde.',
    onlyDevice: 'Este é o único dispositivo com sua conta. Para usá-la de novo, você vai precisar da sua chave de recuperação.',
    dangerTitle: 'Você vai perder esta conta de vez',
    danger: 'Este é seu único dispositivo e você não salvou sua chave de recuperação. Se você sair da conta agora, ninguém vai conseguir recuperá-la: nem você, nem o dono de um servidor.',
    saveFirst: 'Salvar a chave de recuperação antes',
    understand: 'Entendo que esta conta vai sumir de vez',
    leave: 'Sair também dos meus servidores',
    leaveHint: 'Sua conta sai deles em todos os dispositivos: você some das listas de membros e precisa de um novo convite para voltar. Você continua nos servidores dos quais é dono.',
    confirm: 'Sair da conta',
    busy: 'Saindo…',
  },
}
