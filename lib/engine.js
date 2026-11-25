'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const {
  BACKUP_ROOT,
  assertRemoteName,
  authArgs,
  backupSpec,
  backupStamp,
  cleanupArgs,
  decorateEntries,
  isErrorLog,
  moveArgs,
  normalizePath,
  parseJsonLogLine,
  remoteSpec,
  statsFromLog,
  supportedRemotes,
  uniqueRemoteName,
  validateItems,
} = require('./rclone');

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function createEngine({ configPath = null, rclonePath = null } = {}) {
  let runnerCache;
  let activeAuth = null;
  let activeTransfer = null;

  function ensureConfigFile() {
    if (!configPath) return;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, '', { mode: 0o600 });
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // Windows ignores POSIX permissions.
    }
  }

  function configArgs() {
    return configPath ? ['--config', configPath] : [];
  }

  function execFileAsync(file, args, options) {
    return new Promise((resolve) => {
      execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ error, stdout: stdout || '', stderr: stderr || '' });
      });
    });
  }

  function rcloneCandidates() {
    const candidates = [rclonePath, process.env.RCLONE_PATH, 'rclone'];
    if (process.platform === 'darwin') {
      candidates.push('/opt/homebrew/bin/rclone', '/usr/local/bin/rclone', '/opt/local/bin/rclone');
    } else if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA;
      if (local) candidates.push(path.join(local, 'Programs', 'rclone', 'rclone.exe'));
      candidates.push('C:\\Program Files\\rclone\\rclone.exe', 'C:\\Program Files (x86)\\rclone\\rclone.exe');
    } else {
      candidates.push('/usr/bin/rclone', '/usr/local/bin/rclone', '/snap/bin/rclone');
    }
    return [...new Set(candidates.filter(Boolean))];
  }

  async function resolveRclone(refresh = false) {
    if (refresh) runnerCache = undefined;
    if (runnerCache !== undefined) return runnerCache;

    for (const candidate of rcloneCandidates()) {
      if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
      const result = await execFileAsync(candidate, ['version'], { timeout: 8000, windowsHide: true });
      if (result.error) continue;
      const firstLine = result.stdout.split(/\r?\n/, 1)[0].trim();
      if (!/^rclone\s+v/i.test(firstLine)) continue;
      runnerCache = { path: candidate, version: firstLine.replace(/^rclone\s+/i, '') };
      return runnerCache;
    }

    runnerCache = null;
    return null;
  }

  function cleanRcloneError(text) {
    return cleanText(text);
  }

  function spawnRclone(runner, args) {
    ensureConfigFile();
    return spawn(runner.path, [...configArgs(), ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  async function runRclone(args, { timeoutMs = 30000, maxStdout = 32 * 1024 * 1024 } = {}) {
    const runner = await resolveRclone();
    if (!runner) {
      return { ok: false, code: null, stdout: '', stderr: '', error: 'O rclone não está instalado ou não foi encontrado.' };
    }

    let child;
    try {
      child = spawnRclone(runner, args);
    } catch (error) {
      return { ok: false, code: null, stdout: '', stderr: '', error: error.message };
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      if (timeoutMs) {
        timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
          finish({ ok: false, code: null, stdout, stderr, error: 'O rclone demorou demais para responder.' });
        }, timeoutMs);
      }

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > maxStdout) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
          finish({ ok: false, code: null, stdout: '', stderr, error: 'A pasta retornou uma listagem grande demais.' });
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 200000) stderr = stderr.slice(-100000);
      });
      child.on('error', (error) => {
        runnerCache = undefined;
        finish({ ok: false, code: null, stdout, stderr, error: `Não foi possível executar o rclone: ${error.message}` });
      });
      child.on('close', (code) => {
        finish({ ok: code === 0, code, stdout, stderr, error: null });
      });
    });
  }

  async function readConfigDump() {
    const result = await runRclone(['config', 'dump'], { timeoutMs: 30000 });
    if (!result.ok) {
      return {
        ok: false,
        dump: {},
        error: cleanRcloneError(result.stderr) || result.error || 'Não foi possível ler a configuração do rclone.',
      };
    }
    try {
      const dump = (result.stdout || '').trim() ? JSON.parse(result.stdout) : {};
      if (!dump || typeof dump !== 'object' || Array.isArray(dump)) throw new Error('Formato inválido.');
      return { ok: true, dump, error: null };
    } catch {
      return { ok: false, dump: {}, error: 'Não foi possível interpretar a configuração do rclone.' };
    }
  }

  async function readRemotes() {
    const result = await readConfigDump();
    if (!result.ok) return [];
    return supportedRemotes(result.dump);
  }

  async function status({ refresh = false } = {}) {
    const runner = await resolveRclone(Boolean(refresh));
    if (!runner) return { rclone: null, remotes: [], error: null };
    const dump = await readConfigDump();
    return {
      rclone: { version: runner.version },
      remotes: dump.ok ? supportedRemotes(dump.dump) : [],
      error: dump.ok ? null : dump.error,
    };
  }

  async function list(remote, dir) {
    try {
      const remoteName = assertRemoteName(remote);
      const remotePath = normalizePath(dir);
      const runner = await resolveRclone();
      if (!runner) return { ok: false, error: 'O rclone não está instalado ou não foi encontrado.' };

      const remotes = await readRemotes();
      if (!remotes.some((item) => item.name === remoteName)) {
        return { ok: false, error: 'Esta conta não está mais conectada.' };
      }

      const result = await runRclone(['lsjson', remoteSpec(remoteName, remotePath), '--no-mimetype'], {
        timeoutMs: 120000,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: cleanRcloneError(result.stderr) || result.error || 'Não foi possível ler esta pasta.',
        };
      }

      let raw;
      try {
        raw = (result.stdout || '').trim() ? JSON.parse(result.stdout) : [];
      } catch {
        return { ok: false, error: 'O rclone retornou uma listagem inesperada.' };
      }
      if (!Array.isArray(raw)) return { ok: false, error: 'O rclone retornou uma listagem inesperada.' };

      return { ok: true, entries: decorateEntries(raw).filter((entry) => entry.name) };
    } catch (error) {
      return { ok: false, error: error.message || 'Não foi possível ler esta pasta.' };
    }
  }

  function startAuth(payload, { onUrl } = {}) {
    if (activeAuth) {
      return { promise: Promise.resolve({ ok: false, error: 'Já existe uma conexão em andamento.' }), cancel() {} };
    }

    const session = { child: null, cancelled: false };
    activeAuth = session;

    const promise = (async () => {
      try {
        if (!payload || typeof payload !== 'object') throw new Error('Pedido inválido.');
        const type = payload.type;
        if (type !== 'drive' && type !== 'onedrive') throw new Error('Tipo de conta inválido.');

        const runner = await resolveRclone();
        if (!runner) return { ok: false, error: 'O rclone não está instalado ou não foi encontrado.' };

        const remotes = await readRemotes();
        const name = uniqueRemoteName(type, remotes);
        const args = authArgs({
          type,
          name,
          clientId: payload.clientId,
          clientSecret: payload.clientSecret,
        });

        if (session.cancelled) return { cancelled: true };

        let child;
        try {
          child = spawnRclone(runner, args);
        } catch (error) {
          return { ok: false, error: `Não foi possível abrir o login: ${error.message}` };
        }
        session.child = child;

        let stdout = '';
        let stderr = '';
        let stderrBuffer = '';
        let urlSent = false;

        const maybeUrl = (text) => {
          if (urlSent || typeof onUrl !== 'function') return;
          const match = String(text).replace(ANSI, '').match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\S+/);
          if (match) {
            urlSent = true;
            onUrl(match[0]);
          }
        };

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout = (stdout + chunk).slice(-12000);
        });
        child.stderr.on('data', (chunk) => {
          stderr = (stderr + chunk).slice(-24000);
          stderrBuffer += chunk;
          const lines = stderrBuffer.split(/\r?\n/);
          stderrBuffer = lines.pop() || '';
          for (const line of lines) maybeUrl(line);
        });

        const closeResult = await new Promise((resolve) => {
          let settled = false;
          const finish = (code, spawnError) => {
            if (settled) return;
            settled = true;
            resolve({ code, spawnError });
          };
          child.on('error', (error) => finish(null, error));
          child.on('close', (code) => finish(code));
        });

        const dumpResult = await readConfigDump();
        const config = dumpResult.ok ? dumpResult.dump[name] : null;
        const token = config && typeof config.token === 'string' ? config.token.trim() : '';
        const configured = Boolean(config && config.type === type && token);

        if (configured) return { ok: true, remote: { name, type } };

        // config create can leave a remote without a token when the OAuth flow fails.
        if (config && config.type === type) {
          await runRclone(['config', 'delete', name], { timeoutMs: 15000 });
        }

        if (session.cancelled) return { cancelled: true };
        if (closeResult.spawnError) {
          runnerCache = undefined;
          return { ok: false, error: `Não foi possível executar o rclone: ${closeResult.spawnError.message}` };
        }
        if (!dumpResult.ok) return { ok: false, error: dumpResult.error };
        return {
          ok: false,
          error:
            cleanRcloneError(stderr) ||
            cleanRcloneError(stdout) ||
            'A conta não foi criada. O login foi concluído no navegador?',
        };
      } catch (error) {
        return { ok: false, error: error.message || 'Não foi possível conectar a conta.' };
      } finally {
        if (activeAuth === session) activeAuth = null;
      }
    })();

    return {
      promise,
      cancel() {
        session.cancelled = true;
        if (session.child) {
          try {
            session.child.kill('SIGTERM');
          } catch {
            // Already gone.
          }
        }
      },
    };
  }

  function cancelAuth() {
    if (!activeAuth) return false;
    activeAuth.cancelled = true;
    if (activeAuth.child) {
      try {
        activeAuth.child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
    return true;
  }

  function startTransfer(payload, { onProgress } = {}) {
    if (activeTransfer) {
      return { promise: Promise.resolve(transferFailure('Já existe uma transferência em andamento.')), cancel() {} };
    }

    const startedAt = Date.now();
    const session = { child: null, cancelled: false, itemIndex: 0, itemCount: 0, itemName: '', isDir: false };
    activeTransfer = session;
    const emit = typeof onProgress === 'function' ? onProgress : () => {};

    const promise = (async () => {
      try {
        if (!payload || typeof payload !== 'object') throw new Error('Pedido inválido.');
        const runner = await resolveRclone();
        if (!runner) return transferFailure('O rclone não está instalado ou não foi encontrado.');

        const remotes = await readRemotes();
        const srcRemote = assertRemoteName(payload.srcRemote);
        const destRemote = assertRemoteName(payload.destRemote);
        if (srcRemote === destRemote) throw new Error('Origem e destino precisam ser contas diferentes.');
        if (!remotes.some((item) => item.name === srcRemote)) throw new Error('A conta de origem não está conectada.');
        if (!remotes.some((item) => item.name === destRemote)) throw new Error('A conta de destino não está conectada.');

        const srcPath = normalizePath(payload.srcPath);
        const destPath = normalizePath(payload.destPath);
        const items = validateItems(payload.items);
        session.itemCount = items.length;

        if (session.cancelled) {
          return {
            ok: false,
            cancelled: true,
            completed: 0,
            total: items.length,
            failed: null,
            backupPath: null,
            elapsedMs: Date.now() - startedAt,
            error: null,
          };
        }

        const stamp = backupStamp();
        let completed = 0;
        let failed = null;
        let cancelled = false;

        for (let index = 0; index < items.length; index += 1) {
          if (session.cancelled) {
            cancelled = true;
            break;
          }

          const item = items[index];
          session.itemIndex = index + 1;
          session.itemName = item.name;
          session.isDir = item.isDir;
          emit({
            phase: 'item',
            itemIndex: index + 1,
            itemCount: items.length,
            itemName: item.name,
            isDir: item.isDir,
            stats: null,
          });

          let args;
          try {
            args = moveArgs({
              item,
              srcRemote,
              srcPath,
              destRemote,
              destPath,
              backup: backupSpec(destRemote, stamp, index),
            });
          } catch (error) {
            failed = { name: item.name, error: error.message };
            break;
          }

          let child;
          try {
            child = spawnRclone(runner, args);
          } catch (error) {
            failed = { name: item.name, error: `Não foi possível iniciar a transferência: ${error.message}` };
            break;
          }
          session.child = child;

          const result = await waitForTransferChild(child, session, emit);
          session.child = null;

          if (result.code === 0) {
            completed += 1;
            if (item.isDir) {
              const cleanup = cleanupArgs({ item, srcRemote, srcPath });
              if (cleanup) await runRclone(cleanup, { timeoutMs: 30000 });
            }
          } else if (session.cancelled) {
            cancelled = true;
            break;
          } else {
            failed = { name: item.name, error: result.error || result.errorText };
            break;
          }

          if (session.cancelled) {
            cancelled = true;
            break;
          }
        }

        return {
          ok: !failed && !cancelled,
          cancelled,
          completed,
          total: items.length,
          failed,
          backupPath: `${BACKUP_ROOT}/${stamp}`,
          elapsedMs: Date.now() - startedAt,
          error: failed ? failed.error : null,
        };
      } catch (error) {
        return transferFailure(error.message || 'Não foi possível iniciar a transferência.', {
          elapsedMs: Date.now() - startedAt,
        });
      } finally {
        if (session.child) {
          try {
            session.child.kill('SIGINT');
          } catch {
            // Already gone.
          }
          session.child = null;
        }
        if (activeTransfer === session) activeTransfer = null;
      }
    })();

    return {
      promise,
      cancel() {
        session.cancelled = true;
        if (session.child) {
          try {
            session.child.kill('SIGINT');
          } catch {
            // Already gone.
          }
        }
      },
    };
  }

  function cancelTransfer() {
    if (!activeTransfer) return false;
    activeTransfer.cancelled = true;
    if (activeTransfer.child) {
      try {
        activeTransfer.child.kill('SIGINT');
      } catch {
        // Already gone.
      }
    }
    return true;
  }

  return {
    cancelAuth,
    cancelTransfer,
    hasActiveAuth: () => Boolean(activeAuth),
    hasActiveTransfer: () => Boolean(activeTransfer),
    list,
    resolveRclone,
    startAuth,
    startTransfer,
    status,
  };
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

function transferErrorText({ errors, lastStats, stderrTail }) {
  const parts = [];
  if (lastStats && lastStats.lastError) parts.push(lastStats.lastError);
  for (const message of errors) {
    if (!parts.includes(message)) parts.push(message);
  }
  if (parts.length === 0) {
    const cleaned = cleanText(stderrTail);
    if (cleaned) parts.push(cleaned);
  }
  return (parts.slice(-5).join('\n') || 'O rclone interrompeu a transferência.').slice(0, 1800);
}

function cleanText(text) {
  return String(text || '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d{4}[/-]\d{2}[/-]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*/, ''))
    .map((line) => line.replace(/^(ERROR|NOTICE|INFO|DEBUG|CRITICAL|FATAL)\s*:\s*/i, ''))
    .filter((line) => !/^Config file .* - using defaults$/i.test(line))
    .slice(-4)
    .join('\n')
    .slice(0, 1500);
}

function waitForTransferChild(child, session, emit) {
  return new Promise((resolve) => {
    let settled = false;
    let stderrBuffer = '';
    let stderrTail = '';
    const errors = [];
    let lastStats = null;

    const handleLine = (rawLine) => {
      const line = String(rawLine).trim();
      if (!line) return;
      const entry = parseJsonLogLine(line);
      if (entry) {
        if (isErrorLog(entry)) {
          errors.push(entry.msg.trim());
          if (errors.length > 20) errors.shift();
        }
        const stats = statsFromLog(entry);
        if (stats) {
          lastStats = stats;
          emit({
            phase: 'stats',
            itemIndex: session.itemIndex,
            itemCount: session.itemCount,
            itemName: session.itemName,
            isDir: session.isDir,
            stats,
          });
        }
        return;
      }
      stderrTail = `${stderrTail}${line}\n`.slice(-8000);
    };

    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });
    child.stdout.on('data', () => {
      // Stats and errors are emitted on stderr. Stdout is drained.
    });

    const finish = (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      if (stderrBuffer) handleLine(stderrBuffer);
      resolve({
        code,
        signal,
        spawnError,
        error: spawnError ? `Não foi possível executar o rclone: ${spawnError.message}` : null,
        errorText: transferErrorText({ errors, lastStats, stderrTail }),
      });
    };

    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

module.exports = { createEngine };
