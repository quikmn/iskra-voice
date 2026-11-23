// Português (Brasil). Same keys as ./en; the compiler flags anything missing or extra.
import type { DesktopText } from './en'

export const text: DesktopText = {
  tray: {
    open: 'Abrir o Iskra',
    about: 'Sobre o Iskra',
    check: 'Buscar atualizações',
    checking: 'Buscando atualizações…',
    downloading: (version: string) => `Baixando ${version}…`,
    restart: (version: string) => `Reiniciar para atualizar para ${version}`,
    download: (version: string) => `Baixar o Iskra ${version}`,
    quit: 'Fechar o Iskra',
  },
  updates: {
    titleReady: 'Atualização pronta',
    titleAvailable: 'Atualização disponível',
  },
  menu: { view: 'Exibir' },
  recordings: {
    pickTitle: 'Onde salvar as gravações de chamadas?',
  },
  backup: {
    pickTitle: 'Restaurar um servidor de um backup',
    filter: 'Backups do Iskra',
    notBackup: 'Esse arquivo não é um backup do Iskra.',
  },
  bots: {
    pickTitle: 'Escolha um bot em que você confia',
    pickMessage: 'Só rode bots em que você confia: um bot roda com as suas permissões neste computador e pode ler e alterar seus arquivos.',
    pickButton: 'Usar esta pasta',
    warnTitle: 'Só rode bots em que você confia',
    runQuestion: (name: string) => `Rodar “${name}” neste computador?`,
    autostartQuestion: (name: string) => `Iniciar “${name}” sempre que o Iskra abrir?`,
    changedQuestion: (name: string) => `“${name}” mudou desde a última vez que você rodou. Rodar mesmo assim?`,
    warnDetail: (folder: string) => `${folder}

Este bot roda com as suas permissões neste computador: ele pode ler e alterar seus arquivos. Só rode bots em que você confia.`,
    run: 'Rodar',
    autostart: 'Iniciar com o Iskra',
    cancel: 'Cancelar',
  },
  template: {
    pickTitle: 'Criar um servidor a partir de um arquivo de modelo',
    filter: 'Modelos do Iskra',
    tooBig: 'Esse arquivo é grande demais para um modelo.',
  },
  host: {
    defaultName: 'Meu servidor',
    noServer: 'Esta versão não inclui o servidor.',
    stoppedEarly: 'O servidor parou logo depois de iniciar. A porta dele está em uso?',
    damaged: 'Os arquivos do servidor estão danificados, então ele não inicia. O server.log na pasta dele diz o que há de errado; restaurar um backup resolve.',
    couldntStart: (error: string) => `Não foi possível iniciar o servidor: ${error}`,
    couldntRun: (error: string) => `Não foi possível rodar o servidor: ${error}`,
    restoreFailed: 'Não foi possível restaurar o backup.',
    noPort: 'Nenhuma porta livre encontrada.',
  },
  keys: {
    mouse: (button: number) => `Mouse ${button}`,
    key: (code: number) => `Tecla ${code}`,
  },
  passkey: {
    title: 'Chave de acesso do Iskra',
    waiting: 'Siga as instruções do seu dispositivo ou da sua chave de segurança.',
  },
  splash: {
    title: 'Iskra',
    starting: 'Iniciando o Iskra…',
    servers: 'Iniciando seus servidores…',
    connecting: 'Conectando…',
    ready: 'Tudo pronto',
    updatedTo: (version: string) => `Iskra atualizado para ${version}`,
    updating: (version: string) => `Atualizando o Iskra para ${version}…`,
    updatingDetail: 'Ele volta em alguns segundos.',
  },
  assistant: {
    title: 'Assistente do Iskra',
    question: (host: string) => `Deixar o assistente enviar suas perguntas para ${host}?`,
    detail: 'Só diga sim se foi você quem digitou esse endereço em Minhas configurações → Assistente. O que você perguntar ao assistente, e o que ele ler para você, vai para lá.',
    yes: 'Sim, usar',
    no: 'Não',
  },
  digitalOcean: {
    done: 'Conexão com o DigitalOcean concluída. Você pode fechar esta aba e voltar para o Iskra.',
    denied: 'O Iskra não foi conectado ao DigitalOcean. Você pode fechar esta aba e voltar para o Iskra.',
  },
}
