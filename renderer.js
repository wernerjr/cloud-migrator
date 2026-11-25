'use strict';

const bridge = window.api;
const SVG_NS = 'http://www.w3.org/2000/svg';
const PANE_KEYS = ['drive', 'onedrive'];

const PROVIDERS = {
  drive: { type: 'drive', label: 'Google Drive', icon: 'hard-drive' },
  onedrive: { type: 'onedrive', label: 'OneDrive', icon: 'cloud' },
};

const state = {
  mode: 'local',
  server: null,
  statusError: null,
  rclone: null,
  remotes: [],
  platform: 'darwin',
  statusLoaded: false,
  busy: false,
  panes: {
    drive: newPane('drive'),
    onedrive: newPane('onedrive'),
  },
  transfer: null,
  confirm: null,
  lastGoogleCreds: null,
  settingsBusy: false,
  dismissedTransferIds: new Set(),
};

const ui = {
  modeButton: byId('mode-button'),
  modeLabel: byId('mode-label'),
  modeIcon: byId('mode-icon'),
  modeDot: byId('mode-dot'),
  rcloneVersion: byId('rclone-version'),
  noticeBanner: byId('notice-banner'),
  noticeTitle: byId('notice-title'),
  noticeText: byId('notice-text'),
  noticeActions: byId('notice-actions'),
  selectionSummary: byId('selection-summary'),
  route: byId('route'),
  moveButton: byId('move-button'),
  helpOpen: byId('help-open'),
  helpDialog: byId('help-dialog'),
  confirmDialog: byId('confirm-dialog'),
  confirmTitle: byId('confirm-title'),
  confirmFrom: byId('confirm-from'),
  confirmFromPath: byId('confirm-from-path'),
  confirmTo: byId('confirm-to'),
  confirmToPath: byId('confirm-to-path'),
  confirmItems: byId('confirm-items'),
  confirmMore: byId('confirm-more'),
  confirmRuntime: byId('confirm-runtime'),
  confirmCancel: byId('confirm-cancel'),
  confirmStart: byId('confirm-start'),
  settingsDialog: byId('settings-dialog'),
  settingsForm: byId('settings-form'),
  settingsServerFields: byId('server-fields'),
  settingsUrl: byId('server-url'),
  settingsToken: byId('server-token'),
  settingsTokenHint: byId('server-token-hint'),
  settingsTest: byId('settings-test'),
  settingsTestResult: byId('settings-test-result'),
  settingsError: byId('settings-error'),
  settingsCancel: byId('settings-cancel'),
  settingsSave: byId('settings-save'),
  googleDialog: byId('google-dialog'),
  googleForm: byId('google-form'),
  googleGuide: byId('google-guide'),
  googleClientId: byId('google-client-id'),
  googleClientSecret: byId('google-client-secret'),
  googleError: byId('google-error'),
  googleCancel: byId('google-cancel'),
  dock: byId('transfer-dock'),
  dockIcon: byId('dock-icon'),
  dockTitle: byId('dock-title'),
  dockSub: byId('dock-sub'),
  dockBytes: byId('dock-bytes'),
  dockSpeed: byId('dock-speed'),
  dockEta: byId('dock-eta'),
  dockAction: byId('dock-action'),
  dockProgress: byId('dock-progress'),
  dockNote: byId('dock-note'),
  dockDetails: byId('dock-details'),
  dockError: byId('dock-error'),
  liveStatus: byId('live-status'),
};

const numberOneDecimal = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const numberNoDecimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function byId(id) {
  return document.getElementById(id);
}

function newPane(key) {
  return {
    type: PROVIDERS[key].type,
    remote: '',
    path: '',
    entries: [],
    loading: false,
    error: null,
    selected: new Set(),
    auth: null,
    authError: null,
    loadSeq: 0,
    loadedKey: null,
  };
}

function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function spinner() {
  const span = document.createElement('span');
  span.className = 'spinner';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function actionButton(label, variant, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${variant}`;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function itemLabel(count) {
  return `${count} ${count === 1 ? 'item' : 'itens'}`;
}

function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const formatter = size >= 10 ? numberNoDecimal : numberOneDecimal;
  return `${formatter.format(size)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

function formatEta(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s restantes`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min restantes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `~${hours} h ${rest} min restantes` : `~${hours} h restantes`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 1) return 'menos de 1 s';
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}

function installCommand(platform) {
  if (platform === 'win32') return 'winget install Rclone.Rclone';
  if (platform === 'darwin') return 'brew install rclone';
  return 'sudo apt install rclone';
}

function remotesFor(key) {
  return state.remotes.filter((remote) => remote.type === PROVIDERS[key].type);
}

function otherKey(key) {
  return key === 'drive' ? 'onedrive' : 'drive';
}

function panePathLabel(pane) {
  return `${pane.remote}:/${pane.path}`;
}

function selectedSourceKey() {
  return PANE_KEYS.find((key) => state.panes[key].selected.size > 0) || null;
}

function resetPanePosition(pane) {
  pane.path = '';
  pane.entries = [];
  pane.loading = false;
  pane.error = null;
  pane.selected.clear();
  pane.loadedKey = null;
  pane.loadSeq += 1;
}

function anyAuth() {
  return PANE_KEYS.some((key) => Boolean(state.panes[key].auth));
}

function serverAddress() {
  try {
    return new URL(state.server && state.server.url ? state.server.url : '').host;
  } catch {
    return state.server && state.server.url ? state.server.url : '';
  }
}

function serverHost() {
  try {
    return new URL(state.server && state.server.url ? state.server.url : '').hostname;
  } catch {
    return state.server && state.server.url ? state.server.url : '';
  }
}

function runtimeLabel() {
  if (state.mode !== 'server') return 'Neste computador';
  if (!state.server || !state.server.online) return 'Servidor · offline';
  return `Servidor · ${serverHost()}`;
}

function renderMode() {
  const server = state.mode === 'server';
  ui.modeButton.classList.toggle('is-server', server);
  ui.modeIcon.setAttribute('href', server ? '#i-server' : '#i-monitor');
  ui.modeLabel.textContent = runtimeLabel();
  const ready = Boolean(
    state.server && state.server.online && state.rclone && !state.statusError,
  );
  ui.modeDot.hidden = !server;
  ui.modeDot.classList.toggle('is-online', server && ready);
  ui.modeDot.classList.toggle('is-offline', server && !ready);
  ui.modeButton.disabled = state.busy || anyAuth();
  ui.modeButton.title = server
    ? `Servidor: ${(state.server && state.server.url) || 'não configurado'} · clique para configurar`
    : 'Transferências neste computador · clique para configurar';
  ui.modeButton.setAttribute(
    'aria-label',
    `Configurar onde as transferências rodam. Atual: ${runtimeLabel()}`,
  );
}

function renderRcloneMeta() {
  ui.rcloneVersion.textContent = state.rclone ? `rclone ${state.rclone.version}` : '';
}

function setNoticeText(parts) {
  ui.noticeText.replaceChildren();
  for (const part of parts) {
    if (typeof part === 'string') {
      ui.noticeText.append(document.createTextNode(part));
    } else if (part && part.code) {
      const code = document.createElement('code');
      code.textContent = part.code;
      ui.noticeText.append(code);
    }
  }
}

function retryNoticeButton() {
  return actionButton('Tentar novamente', 'btn-secondary', async () => {
    await refreshStatus({ refreshRclone: true });
  });
}

function renderNotice() {
  if (!state.statusLoaded) {
    ui.noticeBanner.hidden = true;
    return;
  }

  ui.noticeActions.replaceChildren();
  let title = '';
  let parts = null;

  if (state.mode === 'local') {
    if (!state.rclone) {
      title = 'rclone não encontrado';
      parts = [
        'O Cloud Migrator usa o rclone para acessar as duas contas. Instale com ',
        { code: installCommand(state.platform) },
        ' e verifique novamente.',
      ];
      ui.noticeActions.append(
        actionButton('Baixar rclone', 'btn-secondary', () => {
          void bridge.openExternal('https://rclone.org/downloads/');
        }),
        retryNoticeButton(),
      );
    } else if (state.statusError) {
      title = 'Configuração do rclone ilegível';
      parts = [state.statusError];
      ui.noticeActions.append(retryNoticeButton());
    }
  } else if (!state.server || !state.server.online) {
    title = 'Servidor indisponível';
    parts = [(state.server && state.server.error) || 'Não foi possível alcançar o servidor.'];
    ui.noticeActions.append(
      retryNoticeButton(),
      actionButton('Configurar', 'btn-quiet', openSettingsDialog),
    );
  } else if (!state.rclone) {
    title = 'rclone não encontrado no servidor';
    parts = ['O serviço respondeu, mas o rclone não está disponível nele.'];
    ui.noticeActions.append(
      retryNoticeButton(),
      actionButton('Configurar', 'btn-quiet', openSettingsDialog),
    );
  } else if (state.statusError) {
    title = 'Configuração do servidor indisponível';
    parts = [state.statusError];
    ui.noticeActions.append(
      retryNoticeButton(),
      actionButton('Configurar', 'btn-quiet', openSettingsDialog),
    );
  }

  if (!title) {
    ui.noticeBanner.hidden = true;
    return;
  }

  ui.noticeBanner.hidden = false;
  ui.noticeTitle.textContent = title;
  setNoticeText(parts || []);
}

function renderAll() {
  renderMode();
  renderRcloneMeta();
  renderNotice();
  for (const key of PANE_KEYS) renderPane(key);
  updateActionBar();
}

function renderPane(key) {
  const pane = state.panes[key];
  const available = remotesFor(key);
  const accountRow = byId(`account-row-${key}`);
  const select = byId(`remote-${key}`);
  const add = byId(`add-${key}`);
  const refresh = byId(`refresh-${key}`);
  const breadcrumbRow = byId(`breadcrumbs-${key}`);
  const up = byId(`up-${key}`);

  accountRow.hidden = !state.rclone || available.length === 0;
  select.replaceChildren(
    ...available.map((remote) => {
      const option = document.createElement('option');
      option.value = remote.name;
      option.textContent = remote.name;
      return option;
    }),
  );
  select.value = pane.remote;
  select.disabled = state.busy || Boolean(pane.auth);

  add.hidden = !state.rclone || available.length === 0;
  add.disabled = state.busy || Boolean(pane.auth);
  refresh.hidden = !state.rclone || !pane.remote;
  refresh.disabled = state.busy || pane.loading || Boolean(pane.auth) || Boolean(pane.authError);
  breadcrumbRow.hidden =
    !state.rclone || !pane.remote || Boolean(pane.auth) || Boolean(pane.authError);
  up.disabled = !pane.path;

  renderCrumbs(key);
  renderBody(key);
  renderFoot(key);
}

function renderCrumbs(key) {
  const pane = state.panes[key];
  const nav = byId(`crumbs-${key}`);
  nav.replaceChildren();

  const segments = pane.path ? pane.path.split('/') : [];
  const crumbParts = [''].concat(segments);

  crumbParts.forEach((label, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'crumb-sep';
      separator.textContent = '/';
      separator.setAttribute('aria-hidden', 'true');
      nav.append(separator);
    }

    const targetPath = segments.slice(0, index).join('/');
    const isCurrent = index === crumbParts.length - 1;
    const text = index === 0 ? 'Início' : label;

    if (isCurrent) {
      const current = document.createElement('span');
      current.className = 'crumb';
      current.setAttribute('aria-current', 'page');
      current.textContent = text;
      nav.append(current);
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crumb';
    button.textContent = text;
    button.addEventListener('click', () => {
      void navigateTo(key, targetPath);
    });
    nav.append(button);
  });

  nav.scrollLeft = nav.scrollWidth;
}

function renderFoot(key) {
  const pane = state.panes[key];
  const foot = byId(`foot-${key}`);
  if (
    !pane.remote ||
    pane.loading ||
    pane.error ||
    pane.auth ||
    pane.authError ||
    pane.entries.length === 0
  ) {
    foot.hidden = true;
    foot.replaceChildren();
    return;
  }

  const unavailable = pane.entries.filter((entry) => !entry.selectable).length;
  foot.hidden = false;
  foot.replaceChildren(document.createTextNode(itemLabel(pane.entries.length)));
  if (unavailable > 0) {
    const alert = document.createElement('span');
    alert.className = 'foot-alert';
    alert.textContent = ` · ${unavailable} ${unavailable === 1 ? 'indisponível' : 'indisponíveis'}`;
    foot.append(alert);
    foot.title = 'Itens com nomes duplicados ou não suportados não podem ser movidos.';
  } else {
    foot.removeAttribute('title');
  }
}

function makeMessage({ iconName, showSpinner = false, title, text, detail, actions = [], role }) {
  const message = document.createElement('div');
  message.className = 'message';
  if (role) message.setAttribute('role', role);
  if (showSpinner) message.append(spinner());
  else if (iconName) message.append(icon(iconName, 'icon message-icon'));

  const heading = document.createElement('p');
  heading.className = 'message-title';
  heading.textContent = title;
  message.append(heading);

  if (text) {
    const paragraph = document.createElement('p');
    paragraph.className = 'message-text';
    paragraph.textContent = text;
    message.append(paragraph);
  }

  if (detail) {
    const box = document.createElement('div');
    box.className = 'error-box';
    box.textContent = detail;
    message.append(box);
  }

  if (actions.length > 0) {
    const row = document.createElement('div');
    row.className = 'message-actions';
    row.append(...actions);
    message.append(row);
  }

  return message;
}

function renderBody(key) {
  const pane = state.panes[key];
  const body = byId(`body-${key}`);
  body.replaceChildren();
  body.setAttribute('aria-busy', pane.loading ? 'true' : 'false');

  if (!state.rclone) {
    if (state.mode === 'server') {
      const offline = !state.server || !state.server.online;
      body.append(
        makeMessage({
          iconName: 'alert',
          title: offline ? 'Servidor indisponível' : 'Servidor sem rclone',
          text: offline
            ? 'Verifique a conexão e o token do servidor.'
            : 'O servidor respondeu, mas o rclone não está disponível nele.',
          actions: [
            actionButton('Tentar novamente', 'btn-secondary', () => {
              void refreshStatus({ refreshRclone: true });
            }),
          ],
        }),
      );
    } else {
      body.append(
        makeMessage({
          title: 'rclone necessário',
          text: 'Instale o rclone para conectar uma conta. O comando está no aviso acima.',
        }),
      );
    }
    return;
  }

  if (pane.auth) {
    body.append(
      makeMessage({
        showSpinner: true,
        role: 'status',
        title: pane.auth.cancelling ? 'Cancelando conexão' : 'Aguardando autorização',
        text: pane.auth.cancelling
          ? 'Fechando o processo de login.'
          : 'Conclua o login na janela do navegador que foi aberta.',
        actions: [
          actionButton(pane.auth.cancelling ? 'Cancelando…' : 'Cancelar', 'btn-secondary', () => {
            void cancelAuth(key);
          }),
        ],
      }),
    );
    const cancelButton = body.querySelector('.message-actions .btn');
    if (cancelButton) cancelButton.disabled = pane.auth.cancelling;
    return;
  }

  if (pane.authError) {
    body.append(
      makeMessage({
        iconName: 'alert',
        role: 'alert',
        title: 'Não foi possível conectar',
        text: pane.authError,
        actions: [
          actionButton('Tentar novamente', 'btn-secondary', () => {
            if (pane.type === 'drive') openGoogleDialog();
            else void startAuth(key);
          }),
          actionButton('Fechar aviso', 'btn-quiet', () => {
            pane.authError = null;
            renderPane(key);
            updateActionBar();
          }),
        ],
      }),
    );
    return;
  }

  if (!pane.remote) {
    const provider = PROVIDERS[key];
    body.append(
      makeMessage({
        iconName: provider.icon,
        title: `${provider.label} não conectado`,
        text: 'Conecte uma conta para navegar e mover arquivos.',
        actions: [
          actionButton(`Conectar ${provider.label}`, 'btn-secondary', () => {
            if (key === 'drive') openGoogleDialog();
            else void startAuth(key);
          }),
        ],
      }),
    );
    return;
  }

  if (pane.loading) {
    body.append(makeMessage({ showSpinner: true, title: 'Carregando', role: 'status' }));
    return;
  }

  if (pane.error) {
    body.append(
      makeMessage({
        iconName: 'alert',
        role: 'alert',
        title: 'Não foi possível abrir a pasta',
        detail: pane.error,
        actions: [
          actionButton('Tentar novamente', 'btn-secondary', () => {
            void loadPane(key);
          }),
        ],
      }),
    );
    return;
  }

  if (pane.entries.length === 0) {
    body.append(
      makeMessage({
        iconName: 'folder',
        title: 'Pasta vazia',
        text: 'Nada para mover nesta pasta.',
      }),
    );
    return;
  }

  body.append(buildFileScroll(key, pane));
}

function buildFileScroll(key, pane) {
  const scroll = document.createElement('div');
  scroll.className = 'file-scroll';

  const head = document.createElement('div');
  head.className = 'table-head file-cols';
  head.setAttribute('aria-hidden', 'true');
  const blank = document.createElement('span');
  const name = document.createElement('span');
  name.textContent = 'Nome';
  const size = document.createElement('span');
  size.className = 'num col-size';
  size.textContent = 'Tamanho';
  const date = document.createElement('span');
  date.className = 'num col-date';
  date.textContent = 'Modificado';
  head.append(blank, name, size, date);

  const list = document.createElement('div');
  list.className = 'file-list';
  list.setAttribute('role', 'list');

  for (const entry of pane.entries) {
    list.append(buildFileRow(key, pane, entry));
  }

  scroll.append(head, list);
  return scroll;
}

function buildFileRow(key, pane, entry) {
  const row = document.createElement('div');
  row.className = 'file-row file-cols';
  row.dataset.name = entry.name;
  row.setAttribute('role', 'listitem');
  if (!entry.selectable) row.classList.add('is-disabled');
  if (pane.selected.has(entry.name)) row.classList.add('is-selected');
  row.title = entry.note ? `${entry.name} — ${entry.note}` : entry.name;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'file-checkbox';
  checkbox.checked = pane.selected.has(entry.name);
  checkbox.disabled = state.busy || !entry.selectable;
  checkbox.setAttribute(
    'aria-label',
    `${entry.isDir ? 'Selecionar pasta' : 'Selecionar arquivo'} ${entry.name}${
      entry.note ? `. ${entry.note}` : ''
    }`,
  );
  checkbox.addEventListener('change', () => {
    setSelected(key, entry.name, checkbox.checked);
  });

  const nameCell = document.createElement('div');
  nameCell.className = 'file-name-cell';
  nameCell.append(icon(entry.isDir ? 'folder' : 'file', 'icon file-icon'));

  if (entry.isDir && entry.selectable) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'file-name-button';
    open.setAttribute('aria-label', `Abrir pasta ${entry.name}`);
    const label = document.createElement('span');
    label.className = 'file-name';
    label.textContent = entry.name;
    open.append(label, icon('chevron-right'));
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      void openFolder(key, entry);
    });
    nameCell.append(open);
  } else {
    const label = document.createElement('span');
    label.className = 'file-name';
    label.textContent = entry.name;
    nameCell.append(label);
  }

  if (!entry.selectable) {
    const warning = icon('alert', 'row-warning');
    warning.setAttribute('title', entry.note || 'Indisponível');
    nameCell.append(warning);
    const note = document.createElement('span');
    note.className = 'sr-only';
    note.textContent = entry.note || 'Indisponível';
    nameCell.append(note);
  }

  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = entry.isDir ? '—' : formatBytes(entry.size);

  const modified = document.createElement('span');
  modified.className = 'file-date';
  modified.textContent = formatDate(entry.modTime);

  row.append(checkbox, nameCell, size, modified);

  row.addEventListener('click', (event) => {
    if (state.busy || !entry.selectable) return;
    if (event.target.closest('input, button, a')) return;
    setSelected(key, entry.name, !pane.selected.has(entry.name));
  });

  row.addEventListener('dblclick', (event) => {
    if (state.busy || !entry.isDir || !entry.selectable) return;
    if (event.target.closest('input, button, a')) return;
    void openFolder(key, entry);
  });

  return row;
}

function syncSelectionDom(key) {
  const pane = state.panes[key];
  const body = byId(`body-${key}`);
  for (const row of body.querySelectorAll('.file-row')) {
    const selected = pane.selected.has(row.dataset.name);
    row.classList.toggle('is-selected', selected);
    const checkbox = row.querySelector('.file-checkbox');
    if (checkbox) checkbox.checked = selected;
  }
}

function setSelected(key, name, selected) {
  if (state.busy) return;
  const pane = state.panes[key];
  const entry = pane.entries.find((item) => item.name === name);
  if (!entry || !entry.selectable) return;

  if (selected) {
    const siblingKey = otherKey(key);
    const sibling = state.panes[siblingKey];
    if (sibling.selected.size > 0) {
      sibling.selected.clear();
      syncSelectionDom(siblingKey);
    }
    pane.selected.add(name);
  } else {
    pane.selected.delete(name);
  }

  syncSelectionDom(key);
  updateActionBar();
}

function updateActionBar() {
  const sourceKey = state.busy ? null : selectedSourceKey();
  const count = sourceKey ? state.panes[sourceKey].selected.size : 0;
  const destKey = sourceKey ? otherKey(sourceKey) : null;
  const destPane = destKey ? state.panes[destKey] : null;
  const authenticating = PANE_KEYS.some((key) => Boolean(state.panes[key].auth));

  ui.route.hidden = true;
  ui.route.replaceChildren();

  if (state.busy) {
    ui.selectionSummary.textContent = 'Transferência em andamento';
  } else if (!state.rclone) {
    ui.selectionSummary.textContent = 'Instale o rclone para conectar contas';
  } else if (sourceKey) {
    ui.selectionSummary.textContent = `${count} ${count === 1 ? 'item selecionado' : 'itens selecionados'}`;
  } else {
    ui.selectionSummary.textContent = 'Selecione itens em um dos lados';
  }

  if (sourceKey && destKey) {
    ui.route.hidden = false;
    ui.route.append(
      spanText(PROVIDERS[sourceKey].label),
      icon('arrow-right'),
      spanText(PROVIDERS[destKey].label),
    );
  }

  const canMove = Boolean(
    sourceKey &&
      count > 0 &&
      state.rclone &&
      !state.busy &&
      !authenticating &&
      destPane &&
      destPane.remote &&
      !state.panes[sourceKey].loading,
  );

  if (state.busy) {
    ui.moveButton.textContent = 'Movendo…';
  } else if (count > 0) {
    ui.moveButton.textContent = `Mover ${count} ${count === 1 ? 'item' : 'itens'}`;
  } else {
    ui.moveButton.textContent = 'Mover selecionados';
  }
  ui.moveButton.disabled = !canMove;

  if (!state.rclone) {
    ui.moveButton.title = 'rclone não instalado';
  } else if (authenticating) {
    ui.moveButton.title = 'Aguarde a conexão da conta';
  } else if (sourceKey && (!destPane || !destPane.remote)) {
    ui.moveButton.title = 'Conecte uma conta no outro lado';
  } else if (sourceKey && destPane) {
    ui.moveButton.title = `Mover para ${PROVIDERS[destKey].label}${
      destPane.path ? ` · ${destPane.path}` : ' · raiz'
    }`;
  } else {
    ui.moveButton.removeAttribute('title');
  }
}

function spanText(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

async function refreshStatus({ refreshRclone = false, preferredRemote = {} } = {}) {
  let status;
  try {
    status = await bridge.status(refreshRclone);
  } catch (error) {
    status = {
      mode: state.mode,
      server: state.mode === 'server' ? { ...(state.server || {}), online: false, error: error.message } : null,
      rclone: null,
      remotes: [],
      platform: state.platform,
      error: error.message,
      transfer: null,
    };
  }

  const nextMode = status && status.mode === 'server' ? 'server' : 'local';
  const modeChanged = nextMode !== state.mode;
  state.mode = nextMode;
  state.server = status && status.server ? status.server : nextMode === 'server' ? { url: '', online: false, error: 'Servidor não configurado.' } : null;
  state.statusError = status && status.error ? status.error : null;
  state.rclone = status && status.rclone ? status.rclone : null;
  state.remotes = status && Array.isArray(status.remotes) ? status.remotes : [];
  state.platform = (status && status.platform) || state.platform;
  state.statusLoaded = true;

  if (modeChanged) {
    for (const key of PANE_KEYS) state.panes[key] = newPane(key);
    state.busy = false;
    state.transfer = null;
    ui.dock.hidden = true;
    ui.dock.className = 'dock';
    state.confirm = null;
  }

  for (const key of PANE_KEYS) {
    const pane = state.panes[key];
    const available = remotesFor(key);
    let chosen = preferredRemote[key];

    if (!chosen || !available.some((remote) => remote.name === chosen)) {
      if (pane.remote && available.some((remote) => remote.name === pane.remote)) chosen = pane.remote;
      else chosen = available[0] ? available[0].name : '';
    }

    if (!state.rclone) chosen = '';

    if (chosen !== pane.remote) {
      resetPanePosition(pane);
      pane.remote = chosen;
    }

    if (!state.rclone) {
      if (pane.entries.length > 0) resetPanePosition(pane);
      pane.remote = '';
      pane.loading = false;
    }
  }

  const toLoad = [];
  for (const key of PANE_KEYS) {
    const pane = state.panes[key];
    const wanted = `${pane.remote}:${pane.path}`;
    if (
      state.rclone &&
      pane.remote &&
      !pane.auth &&
      !pane.authError &&
      !pane.loading &&
      pane.loadedKey !== wanted
    ) {
      pane.loading = true;
      toLoad.push(key);
    }
  }

  renderAll();

  for (const key of toLoad) {
    void loadPane(key);
  }

  if (nextMode === 'server' && status && status.transfer) {
    maybeRestoreServerTransfer(status.transfer);
  }
}

async function loadPane(key) {
  const pane = state.panes[key];
  pane.loadSeq += 1;
  const seq = pane.loadSeq;

  if (!state.rclone || !pane.remote) {
    pane.loading = false;
    renderPane(key);
    updateActionBar();
    return;
  }

  pane.loading = true;
  pane.error = null;
  pane.selected.clear();
  renderPane(key);
  updateActionBar();

  try {
    const result = await bridge.list(pane.remote, pane.path);
    if (seq !== pane.loadSeq) return;
    pane.loading = false;
    if (result && result.ok) {
      pane.entries = Array.isArray(result.entries) ? result.entries : [];
      pane.error = null;
      pane.loadedKey = `${pane.remote}:${pane.path}`;
    } else {
      pane.entries = [];
      pane.error = (result && result.error) || 'Não foi possível abrir esta pasta.';
    }
  } catch (error) {
    if (seq !== pane.loadSeq) return;
    pane.loading = false;
    pane.entries = [];
    pane.error = (error && error.message) || 'Não foi possível abrir esta pasta.';
  }

  renderPane(key);
  updateActionBar();
}

async function navigateTo(key, path) {
  const pane = state.panes[key];
  if (!pane.remote || pane.auth) return;
  pane.path = path;
  pane.entries = [];
  pane.error = null;
  pane.selected.clear();
  pane.loadedKey = null;
  pane.loadSeq += 1;
  await loadPane(key);
  focusFirstItem(key);
}

async function openFolder(key, entry) {
  if (!entry.isDir || !entry.selectable) return;
  const pane = state.panes[key];
  const nextPath = pane.path ? `${pane.path}/${entry.name}` : entry.name;
  await navigateTo(key, nextPath);
}

function focusFirstItem(key) {
  const body = byId(`body-${key}`);
  const target = body.querySelector('.file-checkbox:not(:disabled), .file-name-button:not(:disabled)');
  if (target) {
    target.focus();
    return;
  }
  const up = byId(`up-${key}`);
  if (up && !up.disabled) up.focus();
}

async function changeRemote(key, remoteName) {
  if (state.busy || state.panes[key].auth) return;
  if (!remotesFor(key).some((remote) => remote.name === remoteName)) return;
  const pane = state.panes[key];
  if (pane.remote === remoteName) return;
  pane.remote = remoteName;
  pane.authError = null;
  resetPanePosition(pane);
  await loadPane(key);
  focusFirstItem(key);
}

function openConfirm() {
  if (state.busy) return;
  const sourceKey = selectedSourceKey();
  if (!sourceKey) return;
  const destKey = otherKey(sourceKey);
  const source = state.panes[sourceKey];
  const destination = state.panes[destKey];
  if (!destination.remote) return;

  const items = source.entries.filter((entry) => source.selected.has(entry.name) && entry.selectable);
  if (items.length === 0) return;

  state.confirm = { sourceKey, destKey, items };

  ui.confirmTitle.textContent = `Mover ${items.length} ${items.length === 1 ? 'item' : 'itens'}?`;
  ui.confirmFrom.textContent = PROVIDERS[sourceKey].label;
  ui.confirmFromPath.textContent = panePathLabel(source);
  ui.confirmTo.textContent = PROVIDERS[destKey].label;
  ui.confirmToPath.textContent = panePathLabel(destination);

  const visibleItems = items.slice(0, 6);
  ui.confirmItems.replaceChildren(
    ...visibleItems.map((entry) => {
      const li = document.createElement('li');
      li.append(icon(entry.isDir ? 'folder' : 'file'));
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = entry.name;
      li.append(name);
      return li;
    }),
  );
  ui.confirmMore.hidden = items.length <= visibleItems.length;
  ui.confirmMore.textContent =
    items.length > visibleItems.length
      ? `Mais ${items.length - visibleItems.length} ${
          items.length - visibleItems.length === 1 ? 'item' : 'itens'
        }`
      : '';

  ui.confirmRuntime.replaceChildren(
    icon(state.mode === 'server' ? 'server' : 'monitor'),
    document.createTextNode(
      state.mode === 'server'
        ? `Executado no servidor ${serverAddress() || ''}`.trim()
        : 'Executado neste computador',
    ),
  );

  ui.confirmStart.textContent = `Mover ${items.length} ${items.length === 1 ? 'item' : 'itens'}`;
  ui.confirmStart.disabled = false;
  ui.confirmDialog.showModal();
  ui.confirmCancel.focus();
}

function openGoogleDialog() {
  if (!state.rclone || state.busy) return;
  if (PANE_KEYS.some((key) => Boolean(state.panes[key].auth))) return;
  if (ui.googleDialog.open) return;

  ui.googleError.hidden = true;
  ui.googleError.textContent = '';
  ui.googleClientId.value = state.lastGoogleCreds ? state.lastGoogleCreds.clientId : '';
  ui.googleClientSecret.value = state.lastGoogleCreds ? state.lastGoogleCreds.clientSecret : '';
  ui.googleDialog.showModal();
  ui.googleClientId.focus();
}

function selectedRuntime() {
  const selected = ui.settingsForm.querySelector('input[name="runtime"]:checked');
  return selected && selected.value === 'server' ? 'server' : 'local';
}

function syncSettingsFields() {
  ui.settingsServerFields.hidden = selectedRuntime() !== 'server';
}

function setSettingsBusy(busy) {
  state.settingsBusy = busy;
  ui.settingsSave.disabled = busy;
  ui.settingsTest.disabled = busy;
  ui.settingsCancel.disabled = busy;
  const close = ui.settingsDialog.querySelector('.dialog-close');
  if (close) close.disabled = busy;
}

function setTestResult(message, kind) {
  ui.settingsTestResult.hidden = !message;
  ui.settingsTestResult.textContent = message || '';
  ui.settingsTestResult.className = `test-result${kind ? ` is-${kind}` : ''}`;
}

async function openSettingsDialog() {
  if (!ui.settingsDialog || state.settingsBusy) return;
  if (state.busy || anyAuth()) return;
  if (ui.settingsDialog.open) return;

  let current = {
    mode: state.mode,
    serverUrl: state.server ? state.server.url : '',
    hasToken: false,
    error: null,
  };
  try {
    current = await bridge.settings.get();
  } catch (error) {
    current.error = (error && error.message) || 'Não foi possível ler a configuração do servidor.';
  }

  if (ui.settingsDialog.open) return;
  const radios = ui.settingsForm.querySelectorAll('input[name="runtime"]');
  for (const radio of radios) {
    radio.checked = radio.value === (current.mode === 'server' ? 'server' : 'local');
  }
  ui.settingsUrl.value = current.serverUrl || '';
  ui.settingsToken.value = '';
  ui.settingsToken.placeholder = current.hasToken
    ? 'Token salvo (deixe em branco para manter)'
    : 'Token do servidor';
  ui.settingsTokenHint.textContent = current.hasToken
    ? 'Há um token salvo neste computador.'
    : 'Use o valor de CM_TOKEN definido no servidor.';
  ui.settingsError.hidden = !current.error;
  ui.settingsError.textContent = current.error || '';
  setTestResult('', null);
  setSettingsBusy(false);
  syncSettingsFields();
  ui.settingsDialog.showModal();

  const focusTarget =
    current.mode === 'server'
      ? ui.settingsUrl
      : ui.settingsForm.querySelector('input[name="runtime"]:checked');
  if (focusTarget) focusTarget.focus();
}

async function testSettingsConnection() {
  if (state.settingsBusy) return;
  const serverUrl = ui.settingsUrl.value.trim();
  const token = ui.settingsToken.value.trim();
  ui.settingsError.hidden = true;
  setTestResult('', null);
  setSettingsBusy(true);
  ui.settingsTest.textContent = 'Testando…';

  let result;
  try {
    result = await bridge.settings.test({ serverUrl, token });
  } catch (error) {
    result = { ok: false, error: (error && error.message) || 'Não foi possível testar o servidor.' };
  }

  if (result && result.ok) {
    const parts = ['Conectado'];
    parts.push(result.rclone ? `rclone ${result.rclone.version}` : 'rclone ausente no servidor');
    if (Array.isArray(result.remotes)) {
      parts.push(`${result.remotes.length} ${result.remotes.length === 1 ? 'conta' : 'contas'}`);
    }
    let message = parts.join(' · ');
    let kind = result.rclone ? 'ok' : 'error';
    if (result.error) {
      message += ` · ${result.error}`;
      kind = 'error';
    }
    setTestResult(message, kind);
  } else {
    setTestResult((result && result.error) || 'Não foi possível conectar.', 'error');
  }

  ui.settingsTest.textContent = 'Testar conexão';
  setSettingsBusy(false);
}

async function submitSettings(event) {
  event.preventDefault();
  if (state.settingsBusy) return;

  const mode = selectedRuntime();
  const serverUrl = ui.settingsUrl.value.trim();
  const token = ui.settingsToken.value.trim();
  ui.settingsError.hidden = true;
  setSettingsBusy(true);

  let result;
  try {
    result = await bridge.settings.save({ mode, serverUrl, token });
  } catch (error) {
    result = { ok: false, error: (error && error.message) || 'Não foi possível salvar.' };
  }

  if (!result || !result.ok) {
    ui.settingsError.textContent = (result && result.error) || 'Não foi possível salvar.';
    ui.settingsError.hidden = false;
    setSettingsBusy(false);
    return;
  }

  if (state.transfer) {
    const transfer = state.transfer;
    const id = transfer.server && (transfer.id || (transfer.result && transfer.result.transferId));
    if (id) {
      state.dismissedTransferIds.add(id);
      void bridge.ackMove(id);
    }
    state.transfer = null;
    state.busy = false;
    ui.dock.hidden = true;
    ui.dock.className = 'dock';
  }

  setSettingsBusy(false);
  ui.settingsDialog.close();
  await refreshStatus();
  ui.liveStatus.textContent = 'Modo de transferência atualizado.';
  ui.modeButton.focus();
}

async function startAuth(key, credentials) {
  const pane = state.panes[key];
  if (pane.auth || state.busy) return;

  pane.auth = { cancelling: false };
  pane.authError = null;
  pane.error = null;
  renderPane(key);
  renderMode();
  updateActionBar();
  ui.liveStatus.textContent = 'Aguardando autorização no navegador.';

  let result;
  try {
    result = await bridge.connect({
      type: PROVIDERS[key].type,
      ...(credentials || {}),
    });
  } catch (error) {
    result = { ok: false, error: (error && error.message) || 'Não foi possível conectar a conta.' };
  }

  pane.auth = null;

  if (result && result.ok && result.remote) {
    pane.authError = null;
    await refreshStatus({ preferredRemote: { [key]: result.remote.name } });
    ui.liveStatus.textContent = `${PROVIDERS[key].label} conectado.`;
    return;
  }

  if (result && result.cancelled) {
    pane.authError = null;
    await refreshStatus();
    ui.liveStatus.textContent = 'Conexão cancelada.';
    return;
  }

  pane.authError = (result && result.error) || 'Não foi possível conectar a conta.';
  renderPane(key);
  renderMode();
  updateActionBar();
  ui.liveStatus.textContent = `Não foi possível conectar ${PROVIDERS[key].label}.`;
}

async function cancelAuth(key) {
  const pane = state.panes[key];
  if (!pane.auth || pane.auth.cancelling) return;
  pane.auth.cancelling = true;
  renderPane(key);
  renderMode();
  ui.liveStatus.textContent = 'Cancelando conexão.';
  try {
    await bridge.cancelConnect();
  } catch {
    // The pending auth request still resolves with an error or cancellation.
  }
}

function applyBusy() {
  ui.modeButton.disabled = state.busy || anyAuth();
  for (const key of PANE_KEYS) {
    const pane = state.panes[key];
    const select = byId(`remote-${key}`);
    const add = byId(`add-${key}`);
    const refresh = byId(`refresh-${key}`);
    select.disabled = state.busy || Boolean(pane.auth);
    add.disabled = state.busy || Boolean(pane.auth);
    refresh.disabled = state.busy || pane.loading || Boolean(pane.auth);

    const body = byId(`body-${key}`);
    for (const row of body.querySelectorAll('.file-row')) {
      const checkbox = row.querySelector('.file-checkbox');
      if (checkbox) checkbox.disabled = state.busy || row.classList.contains('is-disabled');
    }
  }
}

function transferSubtitle(transfer) {
  const itemPart =
    transfer.itemCount > 1 ? `Item ${transfer.itemIndex || 1} de ${transfer.itemCount}` : '1 item';
  const serverPart = transfer.server ? ' · servidor' : '';
  return `${itemPart} · ${PROVIDERS[transfer.sourceKey].label} → ${
    PROVIDERS[transfer.destKey].label
  }${serverPart}`;
}

function paintDockRunning(transfer) {
  ui.dock.hidden = false;
  ui.dock.className = 'dock';
  ui.dockIcon.replaceChildren(spinner());
  ui.dockTitle.textContent = transfer.itemName
    ? `Movendo “${transfer.itemName}”`
    : transfer.phase === 'restored'
      ? 'Retomando transferência'
      : 'Preparando transferência';
  ui.dockSub.textContent = transferSubtitle(transfer);
  ui.dockBytes.hidden = true;
  ui.dockSpeed.hidden = true;
  ui.dockEta.hidden = true;
  ui.dockProgress.hidden = false;
  ui.dockProgress.removeAttribute('value');
  ui.dockProgress.removeAttribute('aria-valuetext');
  ui.dockProgress.setAttribute('aria-label', 'Progresso da transferência');
  ui.dockNote.hidden = true;
  ui.dockNote.replaceChildren();
  ui.dockDetails.hidden = true;
  ui.dockDetails.open = false;
  ui.dockError.textContent = '';
  ui.dockAction.textContent = transfer.cancelling ? 'Cancelando…' : 'Cancelar';
  ui.dockAction.disabled = Boolean(transfer.cancelling);
  if (transfer.stats) renderDockStats(transfer);
}

async function startTransfer(pending) {
  const { sourceKey, destKey, items } = pending;
  const source = state.panes[sourceKey];
  const destination = state.panes[destKey];
  if (!source.remote || !destination.remote) return;

  state.busy = true;
  state.transfer = {
    id: null,
    server: state.mode === 'server',
    sourceKey,
    destKey,
    itemCount: items.length,
    itemIndex: 0,
    itemName: '',
    stats: null,
    cancelling: false,
    result: null,
    phase: 'starting',
  };
  const transfer = state.transfer;

  for (const key of PANE_KEYS) {
    state.panes[key].selected.clear();
    syncSelectionDom(key);
  }

  applyBusy();
  updateActionBar();
  paintDockRunning(transfer);
  ui.dockAction.focus();
  ui.liveStatus.textContent = `Transferência iniciada: ${itemLabel(items.length)} de ${
    PROVIDERS[sourceKey].label
  } para ${PROVIDERS[destKey].label}${transfer.server ? ', no servidor' : ''}.`;

  const payload = {
    srcRemote: source.remote,
    srcPath: source.path,
    destRemote: destination.remote,
    destPath: destination.path,
    items: items.map((entry) => ({ name: entry.name, isDir: entry.isDir })),
  };

  let result;
  try {
    result = await bridge.move(payload);
  } catch (error) {
    result = {
      ok: false,
      cancelled: false,
      completed: 0,
      total: items.length,
      failed: null,
      backupPath: null,
      elapsedMs: 0,
      error: (error && error.message) || 'Falha inesperada na transferência.',
    };
  }

  if (!state.transfer || state.transfer !== transfer) return;

  if (result.transferId) transfer.id = result.transferId;
  state.busy = false;
  transfer.result = result;
  transfer.phase = 'result';
  applyBusy();
  renderDockResult(result);
  updateActionBar();

  await Promise.all([loadPane(sourceKey), loadPane(destKey)]);
}

function handleProgress(payload) {
  if (!state.transfer || state.transfer.result || !payload) return;
  const transfer = state.transfer;

  if (payload.phase === 'connection') {
    if (!transfer.server) return;
    ui.dockSub.textContent = 'Sem conexão com o servidor · tentando novamente';
    if (!transfer.connectionIssue) {
      transfer.connectionIssue = true;
      ui.liveStatus.textContent = 'Sem conexão com o servidor. A transferência continua nele.';
    }
    return;
  }

  transfer.connectionIssue = false;

  if (payload.phase === 'item') {
    transfer.itemIndex = payload.itemIndex || 1;
    transfer.itemCount = payload.itemCount || transfer.itemCount;
    transfer.itemName = payload.itemName || '';
    transfer.stats = null;

    ui.dockTitle.textContent = transfer.itemName ? `Movendo “${transfer.itemName}”` : 'Movendo';
    ui.dockSub.textContent = transferSubtitle(transfer);
    ui.dockBytes.hidden = true;
    ui.dockSpeed.hidden = true;
    ui.dockEta.hidden = true;
    ui.dockProgress.hidden = false;
    ui.dockProgress.removeAttribute('value');
    ui.dockProgress.removeAttribute('aria-valuetext');
    return;
  }

  if (payload.phase === 'stats' && payload.stats) {
    transfer.stats = payload.stats;
    ui.dockSub.textContent = transferSubtitle(transfer);
    renderDockStats(transfer);
  }
}

function typeToPaneKey(type) {
  return type === 'drive' || type === 'onedrive' ? type : null;
}

function snapshotToResult(snapshot) {
  return {
    ok: snapshot.status === 'done',
    cancelled: snapshot.status === 'cancelled',
    completed: Number.isFinite(snapshot.completed) ? snapshot.completed : 0,
    total: Number.isFinite(snapshot.total) ? snapshot.total : snapshot.itemCount || 0,
    failed: snapshot.failed || null,
    backupPath: snapshot.backupPath || null,
    elapsedMs: Number.isFinite(snapshot.elapsedMs) ? snapshot.elapsedMs : 0,
    error: snapshot.error || null,
    transferId: snapshot.id,
  };
}

function maybeRestoreServerTransfer(snapshot) {
  if (!snapshot || !snapshot.id || state.transfer) return;
  if (state.dismissedTransferIds.has(snapshot.id)) return;
  if (!['running', 'done', 'cancelled', 'error'].includes(snapshot.status)) return;

  let sourceKey = typeToPaneKey(snapshot.srcType);
  let destKey = typeToPaneKey(snapshot.destType);
  if (!sourceKey) {
    const source = state.remotes.find((remote) => remote.name === snapshot.srcRemote);
    sourceKey = source ? typeToPaneKey(source.type) : null;
  }
  if (!destKey) {
    const destination = state.remotes.find((remote) => remote.name === snapshot.destRemote);
    destKey = destination ? typeToPaneKey(destination.type) : null;
  }
  if (!sourceKey || !destKey || sourceKey === destKey) return;

  const transfer = {
    id: snapshot.id,
    server: true,
    sourceKey,
    destKey,
    itemCount: Number.isFinite(snapshot.itemCount) ? snapshot.itemCount : snapshot.total || 0,
    itemIndex: Number.isFinite(snapshot.itemIndex) ? snapshot.itemIndex : 0,
    itemName: snapshot.itemName || '',
    stats: snapshot.stats || null,
    cancelling: false,
    result: null,
    phase: snapshot.status === 'running' ? 'restored' : 'result',
  };
  state.transfer = transfer;

  if (snapshot.status === 'running') {
    state.busy = true;
    paintDockRunning(transfer);
    applyBusy();
    updateActionBar();
    ui.dockAction.focus();
    ui.liveStatus.textContent = 'Transferência em andamento no servidor retomada.';
    void resumeRestoredTransfer(transfer);
    return;
  }

  transfer.result = snapshotToResult(snapshot);
  state.busy = false;
  ui.dock.hidden = false;
  renderDockResult(transfer.result);
  applyBusy();
  updateActionBar();
  ui.liveStatus.textContent = 'Resultado de transferência do servidor recuperado.';
}

async function resumeRestoredTransfer(transfer) {
  let result;
  try {
    result = await bridge.resumeMove(transfer.id);
  } catch (error) {
    result = {
      ok: false,
      cancelled: false,
      completed: 0,
      total: transfer.itemCount,
      failed: null,
      backupPath: null,
      elapsedMs: 0,
      error: (error && error.message) || 'Não foi possível retomar a transferência.',
      transferId: transfer.id,
    };
  }

  if (!state.transfer || state.transfer !== transfer) return;
  if (result.transferId) transfer.id = result.transferId;
  state.busy = false;
  transfer.result = result;
  transfer.phase = 'result';
  applyBusy();
  renderDockResult(result);
  updateActionBar();
  await Promise.all([loadPane(transfer.sourceKey), loadPane(transfer.destKey)]);
}

function renderDockStats(transfer) {
  const stats = transfer.stats;
  if (!stats) return;

  if (stats.totalBytes > 0) {
    ui.dockBytes.textContent = `${formatBytes(stats.bytes)} de ${formatBytes(stats.totalBytes)}`;
    ui.dockBytes.hidden = false;
    const percent = Math.max(0, Math.min(100, (stats.bytes / stats.totalBytes) * 100));
    ui.dockProgress.value = percent;
    ui.dockProgress.setAttribute(
      'aria-valuetext',
      `${Math.round(percent)} por cento, ${formatBytes(stats.bytes)} de ${formatBytes(stats.totalBytes)}`,
    );
  } else if (stats.bytes > 0) {
    ui.dockBytes.textContent = formatBytes(stats.bytes);
    ui.dockBytes.hidden = false;
    ui.dockProgress.removeAttribute('value');
    ui.dockProgress.removeAttribute('aria-valuetext');
  } else {
    ui.dockBytes.hidden = true;
    ui.dockProgress.removeAttribute('value');
    ui.dockProgress.removeAttribute('aria-valuetext');
  }

  if (stats.speed > 0) {
    ui.dockSpeed.textContent = `${formatBytes(stats.speed)}/s`;
    ui.dockSpeed.hidden = false;
  } else {
    ui.dockSpeed.hidden = true;
  }

  const eta = formatEta(stats.eta);
  if (eta) {
    ui.dockEta.textContent = eta;
    ui.dockEta.hidden = false;
  } else {
    ui.dockEta.hidden = true;
  }
}

function renderDockResult(result) {
  if (!state.transfer) return;
  const transfer = state.transfer;
  if (result && result.transferId) transfer.id = result.transferId;
  const from = PROVIDERS[transfer.sourceKey].label;
  const to = PROVIDERS[transfer.destKey].label;
  const ok = Boolean(result && result.ok);
  const cancelled = Boolean(result && result.cancelled);
  const completed = result && Number.isFinite(result.completed) ? result.completed : 0;
  const total = result && Number.isFinite(result.total) ? result.total : transfer.itemCount;
  const serverSuffix = transfer.server ? ' · servidor' : '';

  ui.dock.className = `dock ${ok ? 'is-done' : cancelled ? 'is-cancelled' : 'is-error'}`;
  ui.dockIcon.replaceChildren(icon(ok ? 'check' : cancelled ? 'x' : 'alert'));
  ui.dockBytes.hidden = true;
  ui.dockSpeed.hidden = true;
  ui.dockEta.hidden = true;

  if (ok) {
    ui.dockTitle.textContent = `${completed} ${completed === 1 ? 'item movido' : 'itens movidos'}`;
    ui.dockSub.textContent = `${from} → ${to} · ${formatDuration(result.elapsedMs)}${serverSuffix}`;
    ui.dockProgress.hidden = false;
    ui.dockProgress.value = 100;
    ui.dockProgress.setAttribute('aria-valuetext', 'Concluído');
    ui.liveStatus.textContent = `${completed} ${completed === 1 ? 'item movido' : 'itens movidos'} de ${from} para ${to}${serverSuffix}.`;
  } else if (cancelled) {
    ui.dockTitle.textContent = 'Transferência cancelada';
    ui.dockSub.textContent = `${completed} de ${total} ${
      total === 1 ? 'item concluído' : 'itens concluídos'
    } · ${from} → ${to}${serverSuffix}`;
    ui.dockProgress.hidden = true;
    ui.liveStatus.textContent = 'Transferência cancelada.';
  } else {
    ui.dockTitle.textContent = 'Transferência interrompida';
    ui.dockSub.textContent = result.failed
      ? `Falha em “${result.failed.name}” · ${completed} de ${total} ${
          total === 1 ? 'item concluído' : 'itens concluídos'
        }${serverSuffix}`
      : `${from} → ${to}${serverSuffix}`;
    ui.dockProgress.hidden = true;
    ui.liveStatus.textContent = result.failed
      ? `Transferência interrompida em ${result.failed.name}.`
      : 'Não foi possível mover os itens.';
  }

  const backupPath = result && result.backupPath;
  ui.dockNote.hidden = !backupPath;
  ui.dockNote.replaceChildren();
  if (backupPath) {
    ui.dockNote.append(document.createTextNode('Backups de substituições, se houver: '));
    const code = document.createElement('code');
    code.textContent = backupPath;
    ui.dockNote.append(code, document.createTextNode(` em ${to}.`));
  }

  const errorText =
    (result && result.failed && result.failed.error) || (result && result.error) || '';
  ui.dockDetails.hidden = !errorText;
  ui.dockDetails.open = false;
  ui.dockError.textContent = errorText;

  ui.dockAction.textContent = 'Fechar';
  ui.dockAction.disabled = false;
}

async function handleDockAction() {
  if (state.busy && state.transfer && !state.transfer.result) {
    if (state.transfer.cancelling) return;
    const transfer = state.transfer;
    transfer.cancelling = true;
    ui.dockAction.disabled = true;
    ui.dockAction.textContent = 'Cancelando…';
    ui.liveStatus.textContent = 'Cancelando transferência.';
    let accepted = false;
    try {
      accepted = await bridge.cancelMove();
    } catch {
      accepted = false;
    }
    if (!accepted && state.transfer === transfer && !transfer.result) {
      transfer.cancelling = false;
      ui.dockAction.disabled = false;
      ui.dockAction.textContent = 'Cancelar';
      ui.dockSub.textContent = 'Sem conexão com o servidor · a transferência continua';
      ui.liveStatus.textContent = 'Não foi possível cancelar agora.';
    }
    return;
  }

  if (state.transfer) {
    const transfer = state.transfer;
    const id = transfer.id || (transfer.result && transfer.result.transferId);
    if (transfer.server && id) {
      state.dismissedTransferIds.add(id);
      void bridge.ackMove(id);
    }
    state.transfer = null;
    ui.dock.hidden = true;
    ui.dock.className = 'dock';
    ui.moveButton.focus();
  }
}

function bindEvents() {
  ui.helpOpen.addEventListener('click', () => {
    ui.helpDialog.showModal();
  });

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => {
      const dialog = byId(button.dataset.close);
      if (dialog && dialog.open) dialog.close();
    });
  }

  ui.modeButton.addEventListener('click', () => {
    void openSettingsDialog();
  });

  for (const radio of ui.settingsForm.querySelectorAll('input[name="runtime"]')) {
    radio.addEventListener('change', syncSettingsFields);
  }
  ui.settingsTest.addEventListener('click', () => {
    void testSettingsConnection();
  });
  ui.settingsCancel.addEventListener('click', () => {
    if (!state.settingsBusy) ui.settingsDialog.close();
  });
  ui.settingsForm.addEventListener('submit', (event) => {
    void submitSettings(event);
  });
  ui.settingsDialog.addEventListener('cancel', (event) => {
    if (state.settingsBusy) event.preventDefault();
  });

  ui.moveButton.addEventListener('click', openConfirm);
  ui.confirmCancel.addEventListener('click', () => ui.confirmDialog.close());
  ui.confirmStart.addEventListener('click', () => {
    const pending = state.confirm;
    if (!pending || state.busy) return;
    ui.confirmDialog.close();
    state.confirm = null;
    void startTransfer(pending);
  });

  ui.googleGuide.addEventListener('click', () => {
    void bridge.openExternal('https://rclone.org/drive/#making-your-own-client-id');
  });
  ui.googleCancel.addEventListener('click', () => ui.googleDialog.close());
  ui.googleForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const clientId = ui.googleClientId.value.trim();
    const clientSecret = ui.googleClientSecret.value.trim();
    let error = '';

    if (!clientId) error = 'Informe o Client ID.';
    else if (!clientId.endsWith('.apps.googleusercontent.com')) {
      error = 'O Client ID termina com .apps.googleusercontent.com.';
    } else if (!clientSecret) {
      error = 'Informe o Client secret.';
    }

    if (error) {
      ui.googleError.textContent = error;
      ui.googleError.hidden = false;
      return;
    }

    state.lastGoogleCreds = { clientId, clientSecret };
    ui.googleDialog.close();
    void startAuth('drive', state.lastGoogleCreds);
  });

  ui.dockAction.addEventListener('click', () => {
    void handleDockAction();
  });

  byId('remote-drive').addEventListener('change', (event) => {
    void changeRemote('drive', event.target.value);
  });
  byId('remote-onedrive').addEventListener('change', (event) => {
    void changeRemote('onedrive', event.target.value);
  });

  byId('add-drive').addEventListener('click', openGoogleDialog);
  byId('add-onedrive').addEventListener('click', () => {
    void startAuth('onedrive');
  });

  byId('refresh-drive').addEventListener('click', () => {
    void loadPane('drive');
  });
  byId('refresh-onedrive').addEventListener('click', () => {
    void loadPane('onedrive');
  });

  byId('up-drive').addEventListener('click', () => {
    const pane = state.panes.drive;
    if (!pane.path) return;
    const parts = pane.path.split('/');
    parts.pop();
    void navigateTo('drive', parts.join('/'));
  });
  byId('up-onedrive').addEventListener('click', () => {
    const pane = state.panes.onedrive;
    if (!pane.path) return;
    const parts = pane.path.split('/');
    parts.pop();
    void navigateTo('onedrive', parts.join('/'));
  });

  if (bridge && typeof bridge.onProgress === 'function') {
    bridge.onProgress(handleProgress);
  }
}

async function init() {
  bindEvents();
  await refreshStatus();
}

void init();
