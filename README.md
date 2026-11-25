# Cloud Migrator

Um app Electron para mover arquivos e pastas entre Google Drive e OneDrive, nos dois sentidos. A interface mostra as duas contas lado a lado; os itens marcados saem da origem e vão para a pasta aberta no outro lado.

## Requisitos

- Node.js 20 ou mais recente
- [rclone](https://rclone.org/downloads/) instalado e disponível no `PATH`
  - macOS: `brew install rclone`
  - Windows: `winget install Rclone.Rclone`
  - Linux: `sudo apt install rclone` (ou o pacote da sua distribuição)

O app detecta automaticamente instalações via Homebrew, winget e caminhos comuns. Também é possível apontar para um binário específico com `RCLONE_PATH=/caminho/para/rclone npm start`.

## Como rodar

```sh
npm install
npm start
```

Para testar as funções de transferência e validação:

```sh
npm test
```

O app não está empacotado. Para gerar um `.dmg`, `.exe` ou AppImage, adicione um empacotador como `electron-builder`; essa etapa ficou de fora para manter o projeto pequeno.

## Conectando as contas

O Cloud Migrator usa uma configuração própria do rclone, guardada na pasta de dados do app. Ele não altera o `rclone.conf` global do seu sistema e não vê contas configuradas fora dele.

### Google Drive

O rclone está aposentando o client ID compartilhado dele ao longo de 2026. Por isso, o app pede um cliente OAuth seu, gratuito:

1. No Google Cloud, crie um cliente OAuth do tipo **App para computador**.
2. Ative a Google Drive API e adicione seu e-mail como testador na tela de consentimento.
3. Cole o Client ID e o Client secret no diálogo de conexão do app.

O botão **Abrir o passo a passo do rclone** dentro do diálogo leva às instruções detalhadas (em inglês). O login abre no navegador padrão. O app nunca pede nem armazena a senha da conta.

Se você mantiver o app OAuth do Google em modo de teste, a autorização pode expirar em cerca de 7 dias. Publique o app no Google Cloud para evitar isso ou crie uma nova conexão quando a antiga expirar.

### OneDrive

Use o botão de conectar no painel do OneDrive. O rclone abre o login da Microsoft no navegador usando o cliente compartilhado dele.

Várias contas do mesmo provedor são suportadas; selecione a conta no menu do painel. As credenciais e os tokens ficam na configuração local do rclone, em uma pasta de dados do app, e não passam por servidor nenhum deste projeto.

## Como as transferências funcionam

- **Mover, não copiar.** Cada item é copiado pelo rclone nesta máquina e a origem só é apagada depois que a cópia termina sem erro. O app não tem modo "copiar e manter a origem".
- **Substituições protegidas.** Se já existe um arquivo com o mesmo nome no destino, ele é substituído e a versão anterior vai para `_cloud-migrator-backups/<data>/<nº do item>` na raiz da conta de destino. Pastas com o mesmo nome são mescladas.
- **Cancelar é seguro.** O rclone interrompe o arquivo atual; o que já foi copiado saiu da origem, e o restante continua nela.
- **Pastas vazias** são preservadas na cópia e a pasta de origem é removida após o sucesso.
- **Nomes ambíguos.** Itens com nomes duplicados na mesma pasta (inclusive quando só diferem por maiúsculas/minúsculas), com `/` no nome, ou com os nomes reservados `.` e `..` ficam desabilitados, porque o caminho sozinho não identifica qual item mover.
- **Google Docs/Sheets/Slides** são exportados no formato padrão do rclone (`docx`, `xlsx`, `pptx`, `svg`). Ao voltar para o Drive, eles são arquivos comuns, não documentos nativos do Google.
- A transferência passa pela sua máquina; Google Drive e OneDrive não copiam diretamente entre si.

## Segurança

- O renderer roda sem acesso ao Node (`contextIsolation`, `sandbox`, sem `nodeIntegration`).
- Todo acesso ao rclone é feito no processo principal, com argumentos separados e sem shell.
- URLs externas são limitadas a `rclone.org`.
- A configuração do rclone é criada com permissão `0600` em sistemas POSIX. Ela contém tokens de acesso como qualquer configuração do rclone; trate-a como credencial.
- O Client secret do Google é passado ao rclone e fica salvo nessa configuração local, não no código nem em `localStorage`.

## Estrutura

```
main.js              processo principal, IPC e execução do rclone
preload.js           ponte segura entre renderer e processo principal
renderer.js          navegação, seleção, confirmação e progresso
index.html           estrutura e ícones SVG
styles.css           interface
lib/rclone.js        validação, comandos e parsing de estatísticas
test/rclone.test.js  testes unitários
assets/              ícones e IBM Plex (licença OFL em assets/fonts/OFL.txt)
```

## Limitações conhecidas

- Uma transferência por vez.
- Sem modo copiar, sincronização contínua, agendamento ou retomada após reiniciar o app.
- Sem empacotamento para distribuição.
- O rclone precisa estar instalado; o app apenas mostra o comando de instalação.
- A configuração do app não é criptografada com senha do rclone.
- Autorizações no modo de teste do Google podem expirar; o app não tem um botão de reconexão de conta, então é preciso criar uma nova conexão (ou publicar o app OAuth).

A fonte IBM Plex é distribuída sob a SIL Open Font License; o texto da licença está em `assets/fonts/OFL.txt`.
