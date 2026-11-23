import type { Messages } from '../types'

export const rental: Messages['rental'] = {
  title: 'Alugar um servidor na DigitalOcean',
  entry: {
    title: 'Ou deixe o app cuidar disso, na DigitalOcean',
    text: 'O app para computador pode alugar e configurar o servidor para você na sua própria conta da DigitalOcean: um botão, cerca de US$ 6 por mês pagos à DigitalOcean.',
    button: 'Alugar na DigitalOcean',
  },
  createLink: 'Quer um servidor que funcione mesmo com este computador desligado?',
  createButton: 'Alugar um na DigitalOcean',
  steps: {
    label: 'Etapas',
    account: 'Conta',
    token: 'Acesso',
    place: 'Servidor',
    create: 'Configuração',
  },
  account: {
    heading: 'Uma conta na DigitalOcean',
    intro: 'Seu servidor roda na DigitalOcean, uma empresa de hospedagem, o tempo todo, para que seus amigos possam entrar mesmo com o seu computador desligado. Você precisa de uma conta lá; o app faz o resto.',
    cost: 'Cerca de <b>US$ 6 por mês</b> pelo menor servidor deles em que o Iskra cabe (1 GB de memória), cobrado por hora. Você vê o preço exato antes de qualquer coisa ser criada. O Iskra é gratuito e não cobra nada.',
    credit: 'Contas novas da DigitalOcean ganham crédito de cadastro, então os primeiros meses podem sair de graça.',
    referral: 'O Iskra leva você à DigitalOcean pelo nosso link de indicação: o Iskra ganha um pouco de crédito na DigitalOcean, que ajuda a pagar nosso próprio servidor. Você paga direto à DigitalOcean; nunca vemos seu servidor nem seu cartão.',
    open: 'Abrir a DigitalOcean',
    have: 'Já tenho uma conta',
  },
  connect: {
    heading: 'Conectar o Iskra à DigitalOcean',
    intro: 'Faça login na DigitalOcean no seu navegador e permita que o Iskra crie um servidor para você. O app recebe uma chave que vale por uma hora, guarda só na memória e a esquece quando a configuração termina.',
    button: 'Conectar à DigitalOcean',
    waiting: 'Esperando você no navegador…',
    cancel: 'Cancelar',
    fallback: 'Usar um token de API',
  },
  token: {
    heading: 'Deixe o app configurar',
    intro: 'Crie uma chave (um “personal access token”) que permite a este app criar o servidor para você. Ela fica na memória do app neste computador, vai só para a DigitalOcean e é descartada quando a configuração termina.',
    step1: 'Na DigitalOcean, abra <tokens>API → Tokens</tokens> e clique em <b>Generate New Token</b>.',
    step2: 'Dê o nome “Iskra setup” e escolha a <b>Expiration</b> mais curta (30 dias, ou Custom para um dia).',
    step3: 'Em <b>Scopes</b>, escolha <b>Custom Scopes</b> e marque só: <b>droplet</b> (create, read, delete), <b>firewall</b> (create, read, delete), <b>regions</b> (read), <b>sizes</b> (read) e <b>tag</b> (create). A DigitalOcean pode marcar sozinha alguns escopos de leitura relacionados; tudo bem.',
    step4: 'Clique em <b>Generate Token</b>, copie o token (ele começa com dop_v1_) e cole aqui.',
    label: 'Token',
    placeholder: 'dop_v1_…',
    next: 'Continuar',
    checking: 'Verificando com a DigitalOcean…',
    back: 'Voltar',
  },
  place: {
    heading: 'Seu servidor',
    region: 'Local',
    regionHint: 'Escolha o mais próximo do seu grupo, para a voz ficar rápida. O app deu um palpite pelo seu fuso horário.',
    regionOption: '{{name}}: {{price}} por mês',
    name: 'Nome do servidor',
    template: 'Ponto de partida',
    size: '{{memory}} de memória, {{vcpus}} CPU, {{disk}} GB de disco, Ubuntu 24.04. <b>{{price}} por mês</b>, cobrado por hora pela DigitalOcean.',
    ssh: 'Permitir também SSH (acesso por terminal)',
    sshHint: 'Desativado por padrão: ninguém precisa fazer login para rodar o Iskra, então o firewall só deixa passar a web e a voz. Você pode liberar depois na DigitalOcean.',
    note: 'Isto cria um servidor (um “droplet”) e um firewall na sua conta da DigitalOcean. Nada é criado antes de você clicar no botão.',
    create: 'Criar servidor por {{price}} por mês',
  },
  progress: {
    heading: 'Configurando {{name}}',
    droplet: 'Criando o servidor na DigitalOcean',
    firewall: 'Adicionando um firewall (só web e voz)',
    booting: 'Ligando o servidor',
    installing: 'Instalando o Iskra e obtendo o certificado HTTPS (geralmente de 3 a 10 minutos)',
    claiming: 'Tornando você o dono',
    keepOpen: 'Deixe esta janela aberta; você pode continuar conversando enquanto isso.',
    address: 'Endereço: {{url}}',
    stop: 'Parar',
  },
  stopAsk: {
    heading: 'Parar a configuração?',
    text: 'O servidor já existe na sua conta da DigitalOcean e custa dinheiro enquanto existir.',
    delete: 'Parar e excluir',
    keep: 'Manter',
    back: 'Continuar configurando',
    kept: 'Mantido. Ele está na sua conta da DigitalOcean (<droplets>Droplets</droplets>); exclua-o lá se não quiser ficar com ele. Para terminar depois, abra Alugar um servidor pequeno e conecte-se a {{ip}}.',
  },
  failed: {
    heading: 'Não deu certo',
    created: 'Um servidor já foi criado na sua conta da DigitalOcean. Ele custa dinheiro enquanto existir.',
    cleanUp: 'Excluir na DigitalOcean',
    cleaning: 'Excluindo…',
    cleaned: 'Excluído. Não sobrou nada desta tentativa na sua conta da DigitalOcean.',
    cleanFailed: 'Não foi possível excluir daqui. Exclua você na DigitalOcean: o servidor em <droplets>Droplets</droplets> e o firewall em <firewalls>Networking → Firewalls</firewalls>.',
    keepWaiting: 'Continuar esperando',
    retry: 'Tentar de novo',
    detail: 'A DigitalOcean disse: {{detail}}',
  },
  errors: {
    token: 'A DigitalOcean não aceitou esse token. Confira se você copiou tudo e se ele não expirou.',
    scope: 'Falta uma permissão para o Iskra na DigitalOcean. Conecte de novo e permita tudo o que for pedido, ou crie um novo token com os escopos das etapas do token.',
    limit: 'Sua conta da DigitalOcean ainda não pode ter mais um servidor (contas novas começam com um limite). Peça à DigitalOcean para aumentar o limite ou exclua um servidor que você não usa.',
    rate: 'A DigitalOcean pediu para irmos mais devagar. Espere um minuto e tente de novo.',
    network: 'Não foi possível acessar a DigitalOcean. Confira sua conexão com a internet e tente de novo.',
    server: 'A DigitalOcean teve um problema. Tente de novo em alguns minutos.',
    invalid: 'A DigitalOcean recusou esse pedido.',
    timeoutBoot: 'O servidor não ligou em 5 minutos.',
    timeoutInstall: 'Seu servidor não respondeu por HTTPS em 25 minutos. Talvez ele ainda esteja instalando ou esperando o certificado.',
    cancelled: 'Interrompido.',
    busy: 'Um servidor já está sendo configurado.',
    denied: 'A DigitalOcean não deu acesso ao Iskra. Tente de novo ou use um token de API.',
    unavailable: 'Atualize o app para computador para alugar um servidor por aqui.',
  },
  done: {
    heading: 'Seu servidor está pronto',
    text: 'Você é o dono de {{name}}. Os backups diários e as atualizações automáticas estão ativados.',
    address: 'Endereço',
    cost: 'Custo',
    costValue: '{{price}} por mês na DigitalOcean',
    save: 'Salvar o documento do seu servidor',
    saved: 'Salvo',
    saveHint: 'Tudo sobre o seu servidor em um arquivo: como convidar amigos, custos e como cancelar, atualizações, backups, como mudá-lo de lugar e um prompt para um assistente de IA. Sem senhas nem chaves.',
    tokenGone: 'O token já foi apagado deste app. Você também pode excluí-lo na DigitalOcean (<tokens>API → Tokens</tokens>).',
    close: 'Ir para o meu servidor',
  },
  doc: {
    fileName: 'Servidor Iskra - {{name}}.md',
    title: '{{name}}: seu servidor do Iskra',
    made: 'Criado pelo app do Iskra em {{date}}. Guarde este arquivo. Ele não contém senhas nem chaves.',
    addressTitle: 'Endereço',
    address:
      '- Endereço: {{url}}\n' +
      '- Endereço IP: {{ip}}\n' +
      '- Na DigitalOcean: o droplet "{{droplet}}" em {{region}} ({{size}}), com o firewall "{{droplet}}-firewall".',
    joinTitle: 'Como seus amigos entram',
    join: 'Abra o servidor no Iskra e clique em **Convidar amigos**: isso cria um link para você enviar. Eles abrem o link no app do Iskra ou em um navegador. Você decide quem entra: os links podem expirar ou funcionar uma vez só, e os cargos definem o que cada pessoa pode fazer.',
    keysTitle: 'Suas chaves e a recuperação',
    keys:
      '- Você é o dono. Sua conta fica nos seus próprios dispositivos, não no servidor. Guarde sua **chave de recuperação** (Minhas configurações → Chave de recuperação) em um lugar seguro: é ela que traz sua conta de volta em um novo dispositivo.\n' +
      '- A chave e os dados do próprio servidor ficam no servidor, em /opt/iskra/world (server.key, iskra.db, uploads/). Os backups diários ficam em /opt/iskra/world/backups.\n' +
      '- As ferramentas de dono ficam no app: Configurações do servidor (membros, cargos, backups, atualizações).',
    costTitle: 'Quanto custa e como cancelar',
    cost:
      '- {{price}} por mês, cobrado por hora pela DigitalOcean. Veja em Billing: {{billing}}. O Iskra não cobra nada.\n' +
      '- Para parar de pagar: na DigitalOcean, abra Droplets ({{droplets}}), escolha "{{droplet}}" e depois Destroy → Destroy this Droplet. Um droplet apenas desligado continua custando dinheiro; destruí-lo encerra a cobrança. Depois, exclua o firewall "{{droplet}}-firewall" em Networking → Firewalls (é grátis, mas fica mais organizado).\n' +
      '- Quer guardar o histórico do seu servidor? Faça um backup antes (Configurações do servidor → Backup e mudança).',
    updatesTitle: 'Atualizações e backups',
    updates:
      '- O Iskra se atualiza sozinho para as novas versões à noite (por volta das 04:00 no horário do servidor, conferindo com os checksums publicados). Configurações do servidor → Atualizações do servidor mostra a versão e permite mudar isso.\n' +
      '- O Ubuntu instala sozinho as próprias atualizações de segurança.\n' +
      '- Um backup é feito todo dia no servidor (os 7 últimos são mantidos). Como eles ficam no mesmo servidor, baixe um de vez em quando também: Configurações do servidor → Backup e mudança → Fazer backup (criptografado com uma frase secreta que você escolhe). Os backups pagos da própria DigitalOcean estão desativados.',
    moveTitle: 'Como mudá-lo de lugar depois',
    move: 'Seu servidor inteiro é uma pasta. Faça um backup em Configurações do servidor → Backup e mudança, restaure-o no novo computador ou servidor (app para computador: Criar um servidor → Restaurar de um backup) e depois use **Mudar este servidor** para que o app de todo mundo siga para o novo endereço. Guia: {{guide}}',
    seesTitle: 'O que o Iskra pode e não pode ver',
    sees:
      'O projeto Iskra não opera nada para o seu servidor e não vê nada: nem seu servidor, nem suas mensagens, nem sua conta da DigitalOcean, nem seu token, nem seu cartão. O app só falou com a DigitalOcean durante a configuração, com o seu token, e já o esqueceu. ' +
      'A DigitalOcean, como qualquer empresa de hospedagem, poderia tecnicamente ler o disco do servidor; as mensagens diretas e os canais criptografados têm criptografia de ponta a ponta, então ela não consegue ler esses. ' +
      'Seu servidor fala com o GitHub (atualizações) e com o Let’s Encrypt (o certificado dele), e os servidores de nomes do sslip.io respondem pelo endereço dele.',
    aiTitle: 'Ajuda de um assistente de IA',
    aiIntro: 'Se algo der errado, cole o texto abaixo em um assistente de IA (Claude, ChatGPT…). Ele descreve exatamente a sua configuração e não contém segredos.',
    sshOpen: 'o SSH (22/tcp) está liberado',
    sshClosed: 'o SSH (22/tcp) não está liberado; para usar SSH ou o Droplet Console, adicione antes a esse firewall uma regra de entrada para TCP 22',
    ai:
      'Eu rodo um servidor do Iskra (um servidor de voz e chat auto-hospedado, https://github.com/quikmn/iskra-voice) em um droplet da DigitalOcean. Por favor, me ajude com um problema. Peça que eu rode comandos e cole a saída, e explique cada comando antes. Foi exatamente assim que ele foi configurado:\n\n' +
      '- Droplet "{{droplet}}" na região {{region}}, tamanho {{size}}, imagem Ubuntu 24.04 LTS (x86-64), IPv4 público {{ip}}.\n' +
      '- Configurado na primeira inicialização por um script de user-data do cloud-init (log: /var/log/iskra-setup.log). Ele instalou o Iskra {{version}} a partir dos releases do GitHub (iskra-server-{{version}}-linux-x64.tar.gz, conferido com o SHA256SUMS.txt).\n' +
      '- Programa em /opt/iskra; dados ("world") em /opt/iskra/world: server.json (configurações), iskra.db (SQLite), server.key, uploads/, backups/, certs/. Tudo pertence ao usuário de sistema "iskra".\n' +
      '- O serviço "iskra" do systemd (/etc/systemd/system/iskra.service) roda "/opt/iskra/iskra-server /opt/iskra/world" como o usuário iskra, com ExecStartPre=-/opt/iskra/iskra-update-guard e AmbientCapabilities=CAP_NET_BIND_SERVICE. A voz é o LiveKit, que o próprio servidor inicia.\n' +
      '- Endereço {{url}} (um nome do sslip.io para o IP). O servidor obtém seu próprio certificado HTTPS do Let’s Encrypt (server.json "Https": {"Mode": "acme"}).\n' +
      '- Portas: 80/tcp (verificação do certificado), 443/tcp (web e WebSocket), 7881/tcp e 7882/udp (voz). Abertas no ufw do droplet (junto com 22/tcp) e no firewall de nuvem da DigitalOcean "{{droplet}}-firewall": {{ssh}}.\n' +
      '- Atualizações automáticas a partir dos releases do GitHub (server.json "Updates": {"Mode": "auto"}) e backups diários em /opt/iskra/world/backups.\n' +
      '- Logs: journalctl -u iskra -n 200 --no-pager. Status: systemctl status iskra. Saúde: curl -s {{url}}/health\n' +
      '- Guia: https://iskra.foo/docs/hosting\n\n' +
      'Meu problema: <descreva aqui>',
  },
}
