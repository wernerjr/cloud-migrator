'use strict';

const PROVIDER_TYPES = new Set(['drive', 'onedrive']);
const MAX_ITEMS = 200;
const BACKUP_ROOT = '_cloud-migrator-backups';
const NAME_LIMIT = 1024;

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

function assertRemoteName(remote) {
  if (typeof remote !== 'string') throw new Error('Conta inválida.');
  const name = remote.trim();
  if (!name || name.length > 100 || /[:\/\0\r\n]/.test(name)) throw new Error('Conta inválida.');
  return name;
}

function normalizePath(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('Caminho inválido.');
  if (value.includes('\0')) throw new Error('Caminho inválido.');
  if (value.length > 4000) throw new Error('Caminho longo demais.');
  return value
    .split('/')
    .filter(Boolean)
    .join('/');
}

function remoteSpec(remote, dir = '') {
  return `${assertRemoteName(remote)}:${normalizePath(dir)}`;
}

function isSafeItemName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= NAME_LIMIT &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0')
  );
}

function itemKey(name) {
  return name.normalize('NFC').toLowerCase();
}

function joinRemotePath(dir, name) {
  if (!isSafeItemName(name)) throw new Error('Nome de item não suportado.');
  const base = normalizePath(dir);
  return base ? `${base}/${name}` : name;
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Selecione ao menos um item.');
  if (items.length > MAX_ITEMS) throw new Error(`Selecione no máximo ${MAX_ITEMS} itens por vez.`);

  const seen = new Set();
  return items.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Item inválido.');
    if (!isSafeItemName(raw.name)) throw new Error('Há um item com nome não suportado.');
    if (typeof raw.isDir !== 'boolean') throw new Error('Item inválido.');
    const key = itemKey(raw.name);
    if (seen.has(key)) throw new Error('Há itens com o mesmo nome na seleção.');
    seen.add(key);
    return { name: raw.name, isDir: raw.isDir };
  });
}

function supportedRemotes(configDump) {
  const remotes = [];
  if (!configDump || typeof configDump !== 'object' || Array.isArray(configDump)) return remotes;
  for (const [rawName, config] of Object.entries(configDump)) {
    if (!config || !PROVIDER_TYPES.has(config.type)) continue;
    try {
      remotes.push({ name: assertRemoteName(rawName), type: config.type });
    } catch {
      // Ignore names rclone accepts but this app cannot address safely.
    }
  }
  return remotes.sort((a, b) => collator.compare(a.name, b.name));
}

function uniqueRemoteName(type, remotes) {
  const base = type === 'drive' ? 'gdrive' : 'onedrive';
  const used = new Set(remotes.map((remote) => remote.name));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Não foi possível criar um nome para a conta.');
}

function backupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function backupSpec(remote, stamp, index) {
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}$/.test(stamp)) throw new Error('Data de backup inválida.');
  if (!Number.isInteger(index) || index < 0) throw new Error('Índice de backup inválido.');
  return remoteSpec(remote, `${BACKUP_ROOT}/${stamp}/${String(index + 1).padStart(2, '0')}`);
}

function authArgs({ type, name, clientId, clientSecret }) {
  if (!PROVIDER_TYPES.has(type)) throw new Error('Tipo de conta inválido.');
  assertRemoteName(name);
  const args = ['config', 'create', name, type, 'config_is_local', 'true'];

  if (type === 'drive') {
    const id = typeof clientId === 'string' ? clientId.trim() : '';
    const secret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
    if (!id.endsWith('.apps.googleusercontent.com') || id.length > 300) {
      throw new Error('Client ID inválido. Ele termina com .apps.googleusercontent.com.');
    }
    if (!secret || secret.length > 300 || /[\0\r\n]/.test(secret)) {
      throw new Error('Client secret inválido.');
    }
    args.push('client_id', id, 'client_secret', secret, 'scope', 'drive');
  }

  args.push('--auto-confirm');
  return args;
}

function moveArgs({ item, srcRemote, srcPath, destRemote, destPath, backup }) {
  if (!item || !isSafeItemName(item.name) || typeof item.isDir !== 'boolean') {
    throw new Error('Item inválido.');
  }
  if (typeof backup !== 'string' || !/^[^:]+:\S/.test(backup)) {
    throw new Error('Destino de backup inválido.');
  }

  const src = remoteSpec(srcRemote, joinRemotePath(srcPath, item.name));
  const dest = remoteSpec(destRemote, joinRemotePath(destPath, item.name));
  const command = item.isDir ? 'move' : 'moveto';
  const args = [
    command,
    src,
    dest,
    '--backup-dir',
    backup,
    '--stats',
    '800ms',
    '--stats-log-level',
    'NOTICE',
    '--use-json-log',
  ];
  if (item.isDir) args.push('--create-empty-src-dirs', '--delete-empty-src-dirs');
  return args;
}

function cleanupArgs({ item, srcRemote, srcPath }) {
  if (!item || !item.isDir) return null;
  return ['rmdir', remoteSpec(srcRemote, joinRemotePath(srcPath, item.name))];
}

function parseJsonLogLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function statsFromLog(entry) {
  if (!entry || !entry.stats || typeof entry.stats !== 'object') return null;
  const source = entry.stats;
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    bytes: number(source.bytes),
    totalBytes: number(source.totalBytes),
    speed: number(source.speed),
    eta: typeof source.eta === 'number' && Number.isFinite(source.eta) ? source.eta : null,
    errors: number(source.errors),
    transfers: number(source.transfers),
    totalTransfers: number(source.totalTransfers),
    elapsedTime: number(source.elapsedTime),
    fatal: source.fatalError === true,
    lastError: typeof source.lastError === 'string' ? source.lastError : null,
  };
}

function isErrorLog(entry) {
  return Boolean(
    entry &&
      (entry.level === 'error' || entry.level === 'fatal' || entry.level === 'critical') &&
      typeof entry.msg === 'string',
  );
}

function decorateEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  const counts = new Map();
  for (const entry of rawEntries) {
    const name = entry && typeof entry.Name === 'string' ? entry.Name : '';
    const key = name ? itemKey(name) : '';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return rawEntries
    .map((entry) => {
      const name = entry && typeof entry.Name === 'string' ? entry.Name : '';
      const duplicate = name ? counts.get(itemKey(name)) > 1 : false;
      const safe = isSafeItemName(name);
      return {
        name,
        isDir: Boolean(entry && entry.IsDir),
        size: entry && typeof entry.Size === 'number' ? entry.Size : null,
        modTime: entry && typeof entry.ModTime === 'string' ? entry.ModTime : null,
        selectable: safe && !duplicate,
        note: !safe ? 'O nome não é suportado' : duplicate ? 'Nome duplicado nesta pasta' : null,
      };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || collator.compare(a.name, b.name));
}

module.exports = {
  BACKUP_ROOT,
  MAX_ITEMS,
  assertRemoteName,
  authArgs,
  backupSpec,
  backupStamp,
  cleanupArgs,
  decorateEntries,
  isErrorLog,
  isSafeItemName,
  joinRemotePath,
  moveArgs,
  normalizePath,
  parseJsonLogLine,
  remoteSpec,
  statsFromLog,
  supportedRemotes,
  uniqueRemoteName,
  validateItems,
};
