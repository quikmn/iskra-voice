import type { Messages } from '../types'

export const claim: Messages['claim'] = {
  title: 'Resgatar um servidor',
  entry: 'Criou um servidor na DigitalOcean ou na sua própria máquina e ele mostra um código de resgate? <a>Resgate-o</a>.',
  intro: 'Um servidor novo do Iskra criado pelo DigitalOcean Marketplace mostra o endereço e um código de resgate no console (DigitalOcean: seu droplet → Console). Digite os dois aqui para virar o dono.',
  address: 'Endereço do servidor',
  addressPlaceholder: 'https://203-0-113-7.sslip.io',
  addressHint: 'Como aparece no console. Um endereço IP também serve.',
  badAddress: 'Isso não parece um endereço de servidor. Use o endereço https:// do console.',
  code: 'Código de resgate',
  codePlaceholder: 'XXXX-XXXX-XXXX-XXXX',
  codeHint: '16 letras e números. Maiúsculas, espaços e hifens não fazem diferença.',
  badCode: 'Um código de resgate tem 16 letras e números, como 7KQ2-ZM8P-X4TD-9HRA.',
  check: 'Verificar',
  checking: 'Verificando o servidor…',
  found: 'Este é o seu servidor. Entrar nele como dono?',
  join: 'Entrar como dono',
  back: 'Alterar',
  errors: {
    unreachable: 'O servidor não respondeu. Confira o endereço e dê a um servidor recém-criado alguns minutos para iniciar e obter o certificado.',
    noClaim: 'Este servidor não está esperando um resgate: ele já tem dono, ou o código expirou depois de 24 horas. Para gerar um novo código, reinicie o servidor (no console: sudo systemctl restart iskra) e olhe de novo.',
    wrongCode: 'Esse código não bate com este servidor. Confira cada letra com o console.',
    busy: 'Tentativas demais a partir daqui. Espere um minuto e tente de novo.',
  },
  note: 'O código fica neste dispositivo: o app só confere a prova do servidor de que ele tem o mesmo código. Ele funciona uma vez, por 24 horas.',
}
