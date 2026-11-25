'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  authArgs,
  backupSpec,
  backupStamp,
  cleanupArgs,
  decorateEntries,
  isSafeItemName,
  moveArgs,
  normalizePath,
  parseJsonLogLine,
  remoteSpec,
  statsFromLog,
  supportedRemotes,
  uniqueRemoteName,
  validateItems,
} = require('../lib/rclone');

test('remoteSpec handles root, nested, spaced and unicode paths', () => {
  assert.equal(remoteSpec('gdrive'), 'gdrive:');
  assert.equal(remoteSpec('gdrive', '/Fotos/2024/'), 'gdrive:Fotos/2024');
  assert.equal(remoteSpec('onedrive', 'Contratos 2025/São Paulo'), 'onedrive:Contratos 2025/São Paulo');
  assert.throws(() => remoteSpec('bad:name'), /Conta inválida/);
  assert.equal(normalizePath('//a//b//'), 'a/b');
});

test('validateItems rejects unsafe, duplicate and malformed selections', () => {
  assert.deepEqual(validateItems([{ name: 'a.txt', isDir: false }]), [{ name: 'a.txt', isDir: false }]);
  assert.throws(() => validateItems([]), /ao menos um/);
  assert.throws(() => validateItems([{ name: 'a/b', isDir: false }]), /nome não suportado/);
  assert.throws(() => validateItems([{ name: 'a', isDir: false }, { name: 'a', isDir: true }]), /mesmo nome/);
  assert.throws(() => validateItems([{ name: 'a.txt', isDir: false }, { name: 'A.txt', isDir: false }]), /mesmo nome/);
  assert.throws(() => validateItems([{ name: 'a', isDir: 'no' }]), /inválido/);
  assert.equal(isSafeItemName('normal.pdf'), true);
  assert.equal(isSafeItemName(''), false);
  assert.equal(isSafeItemName('.'), false);
  assert.equal(isSafeItemName('..'), false);
});

test('folder moves keep the folder name and move safe flags', () => {
  const args = moveArgs({
    item: { name: 'Fotos 2024', isDir: true },
    srcRemote: 'gdrive',
    srcPath: 'Arquivo',
    destRemote: 'onedrive',
    destPath: 'Backup',
    backup: 'onedrive:_cloud-migrator-backups/2026-11-24_22-00-00/01',
  });
  assert.deepEqual(args.slice(0, 5), [
    'move',
    'gdrive:Arquivo/Fotos 2024',
    'onedrive:Backup/Fotos 2024',
    '--backup-dir',
    'onedrive:_cloud-migrator-backups/2026-11-24_22-00-00/01',
  ]);
  assert.ok(args.includes('--create-empty-src-dirs'));
  assert.ok(args.includes('--delete-empty-src-dirs'));
  assert.ok(args.includes('--use-json-log'));
  assert.ok(args.includes('NOTICE'));
  assert.deepEqual(
    cleanupArgs({ item: { name: 'Fotos 2024', isDir: true }, srcRemote: 'gdrive', srcPath: 'Arquivo' }),
    ['rmdir', 'gdrive:Arquivo/Fotos 2024'],
  );
});

test('file moves use moveto and address the full destination file', () => {
  const args = moveArgs({
    item: { name: 'nota.txt', isDir: false },
    srcRemote: 'gdrive',
    srcPath: '',
    destRemote: 'onedrive',
    destPath: 'Backup',
    backup: 'onedrive:_cloud-migrator-backups/2026-11-24_22-00-00/01',
  });
  assert.equal(args[0], 'moveto');
  assert.equal(args[1], 'gdrive:nota.txt');
  assert.equal(args[2], 'onedrive:Backup/nota.txt');
  assert.ok(!args.includes('--delete-empty-src-dirs'));
  assert.equal(cleanupArgs({ item: { name: 'nota.txt', isDir: false }, srcRemote: 'gdrive', srcPath: '' }), null);
});

test('backup paths are per item and timestamped', () => {
  const stamp = backupStamp(new Date(2026, 10, 24, 22, 45, 9, 417));
  assert.equal(stamp, '2026-11-24_22-45-09-417');
  assert.equal(backupSpec('onedrive', stamp, 2), 'onedrive:_cloud-migrator-backups/2026-11-24_22-45-09-417/03');
  assert.throws(() => backupSpec('onedrive', 'ontem', 0), /Data de backup/);
});

test('authArgs builds non-interactive OAuth commands', () => {
  const drive = authArgs({
    type: 'drive',
    name: 'gdrive',
    clientId: '123.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-example',
  });
  assert.deepEqual(drive, [
    'config',
    'create',
    'gdrive',
    'drive',
    'config_is_local',
    'true',
    'client_id',
    '123.apps.googleusercontent.com',
    'client_secret',
    'GOCSPX-example',
    'scope',
    'drive',
    '--auto-confirm',
  ]);
  assert.deepEqual(authArgs({ type: 'onedrive', name: 'onedrive' }), [
    'config',
    'create',
    'onedrive',
    'onedrive',
    'config_is_local',
    'true',
    '--auto-confirm',
  ]);
  assert.throws(
    () => authArgs({ type: 'drive', name: 'gdrive', clientId: 'id-errado', clientSecret: 's' }),
    /Client ID inválido/,
  );
});

test('config dump filtering and account names', () => {
  const remotes = supportedRemotes({
    gdrive: { type: 'drive', token: 'secret' },
    local: { type: 'local' },
    onedrive: { type: 'onedrive' },
    'bad:name': { type: 'drive' },
  });
  assert.deepEqual(remotes, [
    { name: 'gdrive', type: 'drive' },
    { name: 'onedrive', type: 'onedrive' },
  ]);
  assert.equal(uniqueRemoteName('drive', remotes), 'gdrive-2');
  assert.equal(uniqueRemoteName('onedrive', []), 'onedrive');
});

test('stats logs are parsed and invalid lines ignored', () => {
  const line =
    '{"level":"notice","msg":"stats","stats":{"bytes":100,"totalBytes":400,"speed":50,"eta":6,"errors":0,"transfers":1,"totalTransfers":4,"elapsedTime":2,"fatalError":false,"lastError":null}}';
  const entry = parseJsonLogLine(line);
  assert.ok(entry);
  assert.deepEqual(statsFromLog(entry), {
    bytes: 100,
    totalBytes: 400,
    speed: 50,
    eta: 6,
    errors: 0,
    transfers: 1,
    totalTransfers: 4,
    elapsedTime: 2,
    fatal: false,
    lastError: null,
  });
  assert.equal(parseJsonLogLine('2026/11/24 ERROR: falhou'), null);
  assert.equal(statsFromLog({ level: 'notice' }), null);
});

test('listing decoration sorts folders first and disables ambiguous items', () => {
  const entries = decorateEntries([
    { Name: 'z.txt', Size: 10, ModTime: '2026-11-24T10:00:00Z', IsDir: false },
    { Name: 'A', Size: 0, ModTime: '2026-11-24T10:00:00Z', IsDir: true },
    { Name: 'dup.txt', Size: 1, IsDir: false },
    { Name: 'DUP.txt', Size: 2, IsDir: false },
    { Name: 'a/b.txt', Size: 3, IsDir: false },
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['A', 'a/b.txt', 'dup.txt', 'DUP.txt', 'z.txt'],
  );
  assert.equal(entries[0].selectable, true);
  assert.equal(entries[1].selectable, false);
  assert.equal(entries[2].selectable, false);
  assert.equal(entries[2].note, 'Nome duplicado nesta pasta');
  assert.equal(entries[3].selectable, false);
  assert.equal(entries[4].selectable, true);
});
