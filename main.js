'use strict';

const { app, BrowserWindow, Menu, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('./lib/engine');
const { createRemoteClient, normalizeBaseUrl, testServer } = require('./lib/remote');

app.setName('Cloud Migrator');
if (process.platform === 'win32') app.setAppUserModelId('com.cloudmigrator.app');

let mainWindow = null;
let localEngine = null;
let remoteClient = null;
let settingsPath = null;
let settings = { mode: 'local', serverUrl: '', token: '' };
let settingsError = null;

function userDataPath(name) {
  return path.join(app.getPath('userData'), name);
}

function publicSettings() {
  return {
    mode: settings.mode,
    serverUrl: settings.serverUrl,
    hasToken: Boolean(settings.token),
    error: settingsError,
  };
}

function loadSettings() {
  settingsPath = userDataPath('settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const data = JSON.parse(raw);
    let token = '';
    if (typeof data.tokenEnc === 'string' && data.tokenEnc) {
      try {
        token = safeStorage.decryptString(Buffer.from(data.tokenEnc, 'base64'));
      } catch {
        settingsError = 'Não foi possível ler o token salvo do servidor.';
      }
    } else if (typeof data.tokenPlain === 'string') {
      token = data.tokenPlain;
    }
    settings = {
      mode: data.mode === 'server' ? 'server' : 'local',
      serverUrl: typeof data.serverUrl === 'string' ? data.serverUrl : '',
      token,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      settingsError = 'Não foi possível ler a configuração do servidor.';
      console.error(settingsError);
    }
    settings = { mode: 'local', serverUrl: '', token: '' };
  }
  try {
    fs.chmodSync(settingsPath, 0o600);
  } catch {
    // File may not exist or Windows ignores permissions.
  }
}

function writeSettingsFile() {
  const data = {
    version: 1,
    mode: settings.mode,
    serverUrl: settings.serverUrl,
  };
  if (settings.token) {
    if (safeStorage.isEncryptionAvailable()) {
      data.tokenEnc = safeStorage.encryptString(settings.token).toString('base64');
    } else {
      data.tokenPlain = settings.token;
    }
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, settingsPath);
  try {
    fs.chmodSync(settingsPath, 0o600);
  } catch {
    // Windows ignores POSIX permissions.
  }
}

function operationsBusy() {
  return Boolean(
    (localEngine && (localEngine.hasActiveTransfer() || localEngine.hasActiveAuth())) ||
      (remoteClient && (remoteClient.hasActiveTransfer() || remoteClient.hasActiveAuth())),
  );
}

function saveSettings(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Pedido inválido.' };
  if (operationsBusy()) {
    return { ok: false, error: 'Termine ou cancele a transferência ou o login antes de mudar o modo.' };
  }

  const mode = payload.mode === 'server' ? 'server' : payload.mode === 'local' ? 'local' : null;
  if (!mode) return { ok: false, error: 'Modo inválido.' };

  let serverUrl = '';
  if (payload.serverUrl && String(payload.serverUrl).trim()) {
    try {
      serverUrl = normalizeBaseUrl(payload.serverUrl);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  const newToken = typeof payload.token === 'string' ? payload.token.trim() : '';
  if (newToken && newToken.length < 16) {
    return { ok: false, error: 'O token do servidor precisa ter pelo menos 16 caracteres.' };
  }
  const token = newToken || settings.token;
  if (mode === 'server' && !serverUrl) return { ok: false, error: 'Informe a URL do servidor.' };
  if (mode === 'server' && !token) return { ok: false, error: 'Informe o token do servidor.' };

  settings = { mode, serverUrl, token };
  settingsError = null;
  writeSettingsFile();
  return { ok: true, settings: publicSettings() };
}

async function testConnection(payload) {
  const rawUrl = payload && payload.serverUrl ? String(payload.serverUrl).trim() : '';
  const rawToken = payload && typeof payload.token === 'string' ? payload.token.trim() : '';
  if (!rawUrl) return { ok: false, error: 'Informe a URL do servidor.' };
  if (!rawToken && !settings.token) return { ok: false, error: 'Informe o token do servidor.' };

  let serverUrl;
  try {
    serverUrl = normalizeBaseUrl(rawUrl);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  try {
    const result = await testServer(serverUrl, rawToken || settings.token);
    return {
      ok: true,
      rclone: result.rclone || null,
      remotes: Array.isArray(result.remotes) ? result.remotes : [],
      error: result.error || null,
    };
  } catch (error) {
    return { ok: false, error: error.message || 'Não foi possível alcançar o servidor.' };
  }
}

function sendProgress(sender, payload) {
  if (!sender || sender.isDestroyed()) return;
  sender.send('transfer:progress', payload);
}

function transferFailure(error, extra = {}) {
  return {
    ok: false,
    cancelled: false,
    completed: 0,
    total: 0,
    failed: null,
    backupPath: null,
    elapsedMs: 0,
    error,
    ...extra,
  };
}

async function openAuthUrl(value) {
  const url = new URL(String(value));
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.port !== '53682'
  ) {
    throw new Error('URL de login inesperada.');
  }
  await shell.openExternal(url.toString());
}

function installIpc() {
  ipcMain.handle('app:status', async (_event, refresh) => {
    if (settings.mode === 'server') {
      if (!settings.serverUrl || !settings.token) {
        return {
          mode: 'server',
          server: {
            url: settings.serverUrl,
            online: false,
            error: settingsError || 'Servidor não configurado.',
          },
          rclone: null,
          remotes: [],
          error: null,
          transfer: null,
        };
      }
      try {
        const result = await remoteClient.status({ refresh: Boolean(refresh) });
        return {
          mode: 'server',
          server: { url: settings.serverUrl, online: true, error: null },
          rclone: result.rclone || null,
          remotes: Array.isArray(result.remotes) ? result.remotes : [],
          error: result.error || null,
          transfer: result.transfer || null,
        };
      } catch (error) {
        return {
          mode: 'server',
          server: { url: settings.serverUrl, online: false, error: error.message },
          rclone: null,
          remotes: [],
          error: null,
          transfer: null,
        };
      }
    }

    const result = await localEngine.status({ refresh: Boolean(refresh) });
    return {
      mode: 'local',
      server: null,
      rclone: result.rclone || null,
      remotes: Array.isArray(result.remotes) ? result.remotes : [],
      error: result.error || null,
      transfer: null,
    };
  });

  ipcMain.handle('fs:list', async (_event, payload) => {
    try {
      if (!payload || typeof payload !== 'object') throw new Error('Pedido inválido.');
      if (settings.mode === 'server') {
        return await remoteClient.list(payload.remote, payload.path);
      }
      return await localEngine.list(payload.remote, payload.path);
    } catch (error) {
      return { ok: false, error: error.message || 'Não foi possível ler esta pasta.' };
    }
  });

  ipcMain.handle('auth:connect', async (_event, payload) => {
    if (settings.mode === 'server') {
      return remoteClient.authConnect(payload);
    }
    return localEngine.startAuth(payload).promise;
  });

  ipcMain.handle('auth:cancel', async () => {
    if (settings.mode === 'server') return remoteClient.authCancel();
    return localEngine.cancelAuth();
  });

  ipcMain.handle('transfer:start', async (event, payload) => {
    if (settings.mode === 'server') {
      return remoteClient.transfer(payload, { onProgress: (progress) => sendProgress(event.sender, progress) });
    }
    const handle = localEngine.startTransfer(payload, {
      onProgress: (progress) => sendProgress(event.sender, progress),
    });
    return handle.promise;
  });

  ipcMain.handle('transfer:resume', async (event, id) => {
    if (settings.mode !== 'server') return transferFailure('Transferência remota indisponível.');
    return remoteClient.resumeTransfer(id, {
      onProgress: (progress) => sendProgress(event.sender, progress),
    });
  });

  ipcMain.handle('transfer:cancel', async () => {
    if (settings.mode === 'server') return remoteClient.cancelTransfer();
    return localEngine.cancelTransfer();
  });

  ipcMain.handle('transfer:ack', async (_event, id) => {
    if (settings.mode !== 'server') return false;
    return remoteClient.ackTransfer(id);
  });

  ipcMain.handle('settings:get', () => publicSettings());

  ipcMain.handle('settings:test', async (_event, payload) => testConnection(payload));

  ipcMain.handle('settings:save', async (_event, payload) => saveSettings(payload));

  ipcMain.handle('app:open-external', async (_event, value) => {
    try {
      const url = new URL(String(value));
      if (url.protocol !== 'https:' || !['rclone.org', 'www.rclone.org'].includes(url.hostname)) return false;
      await shell.openExternal(url.toString());
      return true;
    } catch {
      return false;
    }
  });
}

function installMenu() {
  const isMac = process.platform === 'darwin';
  const editMenu = {
    label: 'Editar',
    submenu: [
      { role: 'undo', label: 'Desfazer' },
      { role: 'redo', label: 'Refazer' },
      { type: 'separator' },
      { role: 'cut', label: 'Recortar' },
      { role: 'copy', label: 'Copiar' },
      { role: 'paste', label: 'Colar' },
      { role: 'selectAll', label: 'Selecionar tudo' },
    ],
  };
  const viewMenu = {
    label: 'Visualizar',
    submenu: [
      { role: 'zoomIn', label: 'Aumentar zoom' },
      { role: 'zoomOut', label: 'Diminuir zoom' },
      { role: 'resetZoom', label: 'Tamanho original' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Tela cheia' },
    ],
  };
  const windowMenu = {
    label: 'Janela',
    submenu: [
      { role: 'minimize', label: 'Minimizar' },
      { role: 'close', label: 'Fechar' },
    ],
  };
  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: 'Sobre o Cloud Migrator' },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar Cloud Migrator' },
        { role: 'hideOthers', label: 'Ocultar outros' },
        { role: 'unhide', label: 'Mostrar todos' },
        { type: 'separator' },
        { role: 'quit', label: 'Sair do Cloud Migrator' },
      ],
    });
  } else {
    template.push({
      label: 'Arquivo',
      submenu: [{ role: 'quit', label: 'Sair' }],
    });
  }

  template.push(editMenu, viewMenu, windowMenu);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openExternalIfAllowed(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['rclone.org', 'www.rclone.org'].includes(url.hostname)) {
      void shell.openExternal(url.toString());
    }
  } catch {
    // Ignore malformed links.
  }
}

function stopLocalOperations() {
  if (localEngine) {
    localEngine.cancelTransfer();
    localEngine.cancelAuth();
  }
  if (remoteClient) {
    void remoteClient.authCancel();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#f7f4ee',
    show: false,
    title: 'Cloud Migrator',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.on('closed', () => {
    stopLocalOperations();
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    loadSettings();
    localEngine = createEngine({ configPath: userDataPath('rclone.conf') });
    remoteClient = createRemoteClient({
      getSettings: () => ({ url: settings.serverUrl, token: settings.token }),
      openUrl: openAuthUrl,
    });

    installMenu();
    installIpc();
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
    }
    if (process.platform !== 'win32') {
      app.setAboutPanelOptions({
        applicationName: 'Cloud Migrator',
        applicationVersion: app.getVersion(),
        copyright: 'Usa rclone para acessar Google Drive e OneDrive.',
      });
    }
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    stopLocalOperations();
  });
}
