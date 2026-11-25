# Cloud Migrator

Um app Electron para mover arquivos e pastas entre Google Drive e OneDrive, nos dois sentidos. A interface mostra as duas contas lado a lado; os itens marcados saem da origem e vão para a pasta aberta no outro lado.

As transferências podem rodar **neste computador** ou em um **servidor do homelab**. No modo servidor, o app só mostra a interface e dispara o trabalho; o rclone usa a rede do servidor. Sem servidor configurado, o comportamento local continua igual.

## Requisitos

- Node.js 20 ou mais recente para o app e para o servidor
- [rclone](https://rclone.org/downloads/) no local onde a transferência roda
  - macOS local: `brew install rclone`
  - Windows local: `winget install Rclone.Rclone`
  - Linux local: `sudo apt install rclone` (ou o pacote da sua distribuição)
- No modo servidor, o rclone já vem na imagem Docker; fora dela, instale no servidor.

O app detecta instalações via Homebrew, winget e caminhos comuns. Também é possível apontar para um binário específico com `RCLONE_PATH=/caminho/para/rclone`.

## Como rodar o app

```sh
npm install
npm start
```

Testes:

```sh
npm test
```

O app não está empacotado. Para gerar `.dmg`, `.exe` ou AppImage, adicione um empacotador como `electron-builder`; essa etapa ficou de fora para manter o projeto pequeno.

## Modo local

Sem servidor configurado, o app usa uma configuração própria do rclone na pasta de dados dele. Ele não altera o `rclone.conf` global do sistema. Ao abrir **Neste computador** no topo, você pode revisar o modo.

### Google Drive

O rclone está aposentando o client ID compartilhado dele ao longo de 2026. Por isso, o app pede um cliente OAuth seu, gratuito:

1. No Google Cloud, crie um cliente OAuth do tipo **App para computador**.
2. Ative a Google Drive API e adicione seu e-mail como testador na tela de consentimento.
3. Cole o Client ID e o Client secret no diálogo de conexão do app.

O botão **Abrir o passo a passo do rclone** no diálogo leva às instruções detalhadas (em inglês). O login abre no navegador. O app nunca pede nem armazena a senha da conta.

No modo de teste do Google, a autorização pode expirar em cerca de 7 dias. Publique o app no Google Cloud para evitar isso, ou crie uma nova conexão quando a antiga expirar.

### OneDrive

Use o botão de conectar no painel do OneDrive. O rclone abre o login da Microsoft no navegador usando o cliente compartilhado dele.

Várias contas do mesmo provedor são suportadas; selecione a conta no menu do painel.

## Modo servidor

O servidor é um processo Node pequeno que executa o mesmo rclone do modo local, mas na máquina cabeada. O app fala com ele por HTTP com token. As contas são conectadas **pelo próprio app**: o navegador abre na sua máquina e o callback OAuth é encaminhado ao servidor.

### Docker

O `Dockerfile.server` já instala o rclone e roda como usuário não-root. O volume `/data` guarda o `rclone.conf`.

```sh
cp .env.example .env
# edite .env e defina um CM_TOKEN com pelo menos 16 caracteres
docker compose -f docker-compose.server.yml up -d --build
```

O serviço fica em `http://SEU-SERVIDOR:8787`. No app, abra o indicador no topo, escolha **No servidor**, informe essa URL e o mesmo token e teste a conexão.

Para gerar um token:

```sh
openssl rand -hex 32
```

No Maris, publique a imagem (`docker build -f Dockerfile.server -t ... .` e envie para o registry ou use o Git como fonte), exponha a porta `8787`, monte um volume persistente em `/data` e defina `CM_TOKEN`. O endpoint de saúde para probes é `GET /api/health` (sem token). O entrypoint ajusta o dono de `/data` e roda o serviço como usuário `node` (uid 1000); se preferir um volume com `fsGroup: 1000`, também funciona.

O serviço é **stateful**: use uma réplica só. A transferência em andamento e o login OAuth ficam na memória e na porta local do rclone; múltiplas réplicas quebrariam o acompanhamento e o callback. O volume `/data` guarda as contas entre reinícios.

### Template do Maris

O arquivo **`maris-template.json`** é um `TemplateDefinition` importável no Maris. Ele usa:

- o repositório `https://github.com/wernerjr/cloud-migrator.git`, branch `main`
- `Dockerfile.server` com contexto `.`
- porta pública primária `8787` e health check em `/api/health`
- volume `1Gi` em `/data`
- um token `CM_TOKEN` gerado pelo Maris, mostrado uma vez no resultado do deploy

No Maris, importe em **Templates → Import**, escolha o projeto e adicione um domínio HTTP com HTTPS para a porta 8787. Depois do deploy, copie o `CM_TOKEN` gerado, configure o app para usar a URL do domínio e esse token, e mantenha **1 réplica** porque o servidor é stateful.

O build do Maris usa o repositório Git: faça commit e push do `Dockerfile.server`, do `docker-entrypoint.sh` e das mudanças atuais antes de importar. O template não usa uma imagem publicada; ele constrói a partir do `main`.

### Sem Docker

No servidor com Node e rclone instalados:

```sh
export CM_TOKEN="$(openssl rand -hex 32)"
echo "$CM_TOKEN"
CM_HOST=0.0.0.0 CM_PORT=8787 node server.js
```

O rclone usa a configuração padrão do servidor. Para usar outro arquivo, defina `RCLONE_CONFIG=/caminho/rclone.conf`; o Docker já aponta para `/data/rclone.conf`.

### O que acontece se o app fechar

O servidor mantém a transferência e o resultado. Ao reabrir o app, ele encontra a transferência em andamento ou o último resultado não confirmado no servidor, mostra no painel inferior e permite fechar o resultado. Se o servidor reiniciar, o estado da transferência em memória é perdido, embora o `rclone.conf` e as contas permaneçam no volume.

Com servidor configurado e fora do ar, o app **não** cai silenciosamente para o modo local. Isso evitaria mover arquivos a partir da máquina errada. Use o indicador no topo para voltar a **Neste computador** quando quiser.

### Segurança e rede

- O servidor exige `Authorization: Bearer <CM_TOKEN>` em todas as rotas, exceto `/api/health`.
- Rode em LAN/VPN ou coloque atrás de um reverse proxy com HTTPS. O servidor fala HTTP.
- O token fica neste computador, protegido pelo `safeStorage` do Electron quando disponível; caso contrário, em um arquivo `0600`.
- O servidor só expõe status, listagem, transferência, cancelamento e o fluxo de login; não é um shell nem um proxy HTTP aberto.
- O login remoto usa a porta local `127.0.0.1:53682` na máquina do app para receber o callback OAuth. Se essa porta estiver ocupada, o app avisa.
- O servidor de desenvolvimento nativo na mesma máquina do app também usaria a porta 53682 para o login. Nesse cenário, prefira o container ou uma máquina separada.

## Como as transferências funcionam

- **Mover, não copiar.** Cada item é copiado pelo rclone e a origem só é apagada depois que a cópia termina sem erro. O app não tem modo "copiar e manter a origem".
- **Substituições protegidas.** Se já existe um arquivo com o mesmo nome no destino, ele é substituído e a versão anterior vai para `_cloud-migrator-backups/<data>/<nº do item>` na raiz da conta de destino. Pastas com o mesmo nome são mescladas.
- **Cancelar é seguro.** O rclone interrompe o arquivo atual; o que já foi copiado saiu da origem, e o restante continua nela.
- **Pastas vazias** são preservadas na cópia e a pasta de origem é removida após o sucesso.
- **Nomes ambíguos.** Itens com nomes duplicados na mesma pasta (inclusive quando só diferem por maiúsculas/minúsculas), com `/` no nome, ou com os nomes reservados `.` e `..` ficam desabilitados, porque o caminho sozinho não identifica qual item mover.
- **Google Docs/Sheets/Slides** são exportados no formato padrão do rclone (`docx`, `xlsx`, `pptx`, `svg`). Ao voltar para o Drive, eles são arquivos comuns, não documentos nativos do Google.
- A nuvem nunca copia diretamente de um provedor para o outro: no modo local o tráfego passa pela sua máquina; no modo servidor, pelo servidor.

## Estrutura

```
main.js                 processo principal, IPC, escolha local/servidor e settings
preload.js              ponte segura entre renderer e processo principal
renderer.js             navegação, seleção, confirmação, modo e progresso
index.html              estrutura e ícones SVG
styles.css              interface
lib/engine.js           motor rclone local e do servidor
lib/remote.js           cliente HTTP do servidor e proxy do callback OAuth
lib/rclone.js           validação, comandos e parsing de estatísticas
server.js               API HTTP do modo servidor
maris-template.json    TemplateDefinition importável no Maris
Dockerfile.server       imagem do servidor com rclone
docker-entrypoint.sh    ajusta /data e roda o serviço como node
docker-compose.server.yml
test/rclone.test.js     validação de nomes, comandos e estatísticas
test/engine.test.js     mensagens do motor de transferência
test/remote.test.js     validação da URL do servidor
assets/                 ícones e IBM Plex (licença OFL em assets/fonts/OFL.txt)
```

## API do servidor

| Rota | Uso |
| --- | --- |
| `GET /api/health` | Saúde para Docker/Maris, sem token |
| `GET /api/status` | Versão do rclone, contas e transferência atual |
| `GET /api/list?remote=&path=` | Lista uma pasta |
| `POST /api/transfers` | Inicia uma transferência |
| `GET /api/transfers/current` | Transferência atual ou último resultado |
| `GET /api/transfers/:id` | Estado de uma transferência |
| `POST /api/transfers/:id/cancel` | Cancela |
| `POST /api/transfers/:id/ack` | Confirma e limpa um resultado |
| `POST /api/auth` | Inicia um login OAuth |
| `GET /api/auth/:id` | Estado do login |
| `POST /api/auth/:id/cancel` | Cancela o login |
| `POST /api/auth/:id/proxy` | Encaminha o callback OAuth local ao rclone |

## Limitações conhecidas

- Uma transferência por vez.
- Sem modo copiar, sincronização contínua, agendamento ou histórico de transferências.
- Sem empacotamento do app para distribuição.
- O modo servidor guarda a transferência em memória; reiniciar o servidor a interrompe.
- Sem fallback automático para o local quando o servidor está configurado mas indisponível.
- A configuração do rclone do app local não é criptografada com senha do rclone.
- Autorizações no modo de teste do Google podem expirar; o app não tem um botão de reconexão de conta, então é preciso criar uma nova conexão (ou publicar o app OAuth).

A fonte IBM Plex é distribuída sob a SIL Open Font License; o texto da licença está em `assets/fonts/OFL.txt`.
