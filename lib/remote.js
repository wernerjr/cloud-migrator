'use strict';

const http = require('node:http');

const CALLBACK_PORT = 53682;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RemoteError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'RemoteError';
    this.status = status;
  }
}

function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Informe a URL do servidor.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL do servidor inválida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('A URL do servidor precisa usar http ou https.');
  }
  if (url.username || url.password) throw new Error('Não coloque usuário ou senha na URL.');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function remoteFailure(error) {
  return {
    ok: false,
    cancelled: false,
    completed: 0,
    total: 0,
    failed: null,
    backupPath: null,
    elapsedMs: 0,
    error: error && error.message ? error.message : 'O servidor não respondeu.',
  };
}

function userFacingFetchError(error) {
  if (error instanceof RemoteError) return error;
  if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new RemoteError('O servidor demorou demais para responder.', 0);
  }
  return new RemoteError('Não foi possível alcançar o servidor.', 0);
}

async function requestJson(baseUrl, token, pathName, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${pathName}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw userFacingFetchError(error);
  }

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }

  if (!response.ok) {
    throw new RemoteError(data.error || text || `O servidor respondeu com HTTP ${response.status}.`, response.status);
  }
  return data;
}

async function testServer(baseUrl, token) {
  const normalized = normalizeBaseUrl(baseUrl);
  return requestJson(normalized, token, '/api/status', { timeoutMs: 10000 });
}

function createRemoteClient({ getSettings, openUrl }) {
  let activeAuth = null;
  let activeTransfer = null;

  function settings() {
    const value = getSettings();
    if (!value || !value.url || !value.token) throw new RemoteError('Servidor não configurado.', 0);
    return value;
  }

  async function status({ refresh = false } = {}) {
    const config = settings();
    const query = refresh ? '?refresh=1' : '';
    return requestJson(config.url, config.token, `/api/status${query}`, { timeoutMs: 15000 });
  }

  async function list(remote, remotePath) {
    const config = settings();
    const query = new URLSearchParams({ remote, path: remotePath || '' }).toString();
    return requestJson(config.url, config.token, `/api/list?${query}`, { timeoutMs: 150000 });
  }

  function mapResult(snapshot) {
    return {
      ok: snapshot.status === 'done',
      cancelled: snapshot.status === 'cancelled',
      completed: Number.isFinite(snapshot.completed) ? snapshot.completed : 0,
      total: Number.isFinite(snapshot.total) ? snapshot.total : 0,
      failed: snapshot.failed || null,
      backupPath: snapshot.backupPath || null,
      elapsedMs: Number.isFinite(snapshot.elapsedMs) ? snapshot.elapsedMs : 0,
      error: snapshot.error || null,
      transferId: snapshot.id || activeTransfer?.id || null,
    };
  }

  async function pollTransfer(id, onProgress) {
    let emittedItem = '';
    let emittedStats = '';
    while (true) {
      let snapshot;
      try {
        const config = settings();
        snapshot = await requestJson(config.url, config.token, `/api/transfers/${encodeURIComponent(id)}`);
      } catch (error) {
        if (error instanceof RemoteError && error.status === 404) {
          return {
            ...remoteFailure(new Error('A transferência não está mais no servidor.')),
            transferId: id,
          };
        }
        onProgress({
          phase: 'connection',
          itemIndex: 0,
          itemCount: 0,
          itemName: '',
          isDir: false,
          stats: null,
          error: error.message,
        });
        await sleep(2000);
        continue;
      }

      const itemKey = `${snapshot.itemIndex || 0}:${snapshot.itemName || ''}`;
      if (snapshot.itemName && itemKey !== emittedItem) {
        emittedItem = itemKey;
        onProgress({
          phase: 'item',
          itemIndex: snapshot.itemIndex || 1,
          itemCount: snapshot.itemCount || 0,
          itemName: snapshot.itemName,
          isDir: Boolean(snapshot.isDir),
          stats: null,
        });
      }
      if (snapshot.stats) {
        const statsKey = JSON.stringify(snapshot.stats);
        if (statsKey !== emittedStats) {
          emittedStats = statsKey;
          onProgress({
            phase: 'stats',
            itemIndex: snapshot.itemIndex || 1,
            itemCount: snapshot.itemCount || 0,
            itemName: snapshot.itemName || '',
            isDir: Boolean(snapshot.isDir),
            stats: snapshot.stats,
          });
        }
      }

      if (snapshot.status !== 'running') return mapResult(snapshot);
      await sleep(700);
    }
  }

  async function transfer(payload, { onProgress }) {
    if (activeTransfer) return remoteFailure(new Error('Já existe uma transferência em andamento.'));

    const pending = { id: null, cancelRequested: false };
    activeTransfer = pending;
    let started;
    try {
      const config = settings();
      started = await requestJson(config.url, config.token, '/api/transfers', {
        method: 'POST',
        body: payload,
        timeoutMs: 30000,
      });
      if (!started.id) throw new RemoteError('O servidor não criou a transferência.', 0);
    } catch (error) {
      activeTransfer = null;
      return remoteFailure(error);
    }

    pending.id = started.id;
    try {
      if (pending.cancelRequested) {
        const config = settings();
        await requestJson(config.url, config.token, `/api/transfers/${encodeURIComponent(pending.id)}/cancel`, {
          method: 'POST',
          timeoutMs: 20000,
        }).catch(() => {});
      }
      return await pollTransfer(pending.id, onProgress);
    } finally {
      if (activeTransfer === pending) activeTransfer = null;
    }
  }

  async function resumeTransfer(id, { onProgress }) {
    if (activeTransfer) return remoteFailure(new Error('Já existe uma transferência em andamento.'));
    activeTransfer = { id, cancelRequested: false };
    try {
      return await pollTransfer(id, onProgress);
    } finally {
      activeTransfer = null;
    }
  }

  async function cancelTransfer() {
    if (!activeTransfer) return false;
    activeTransfer.cancelRequested = true;
    if (!activeTransfer.id) return true;
    try {
      const config = settings();
      await requestJson(config.url, config.token, `/api/transfers/${encodeURIComponent(activeTransfer.id)}/cancel`, {
        method: 'POST',
        timeoutMs: 20000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function ackTransfer(id) {
    if (!id) return false;
    try {
      const config = settings();
      await requestJson(config.url, config.token, `/api/transfers/${encodeURIComponent(id)}/ack`, {
        method: 'POST',
        timeoutMs: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function closeProxy(proxy) {
    if (!proxy) return;
    try {
      await proxy.close();
    } catch {
      // Already closed.
    }
  }

  async function startCallbackProxy(auth, config) {
    let proxy;
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Método não permitido.');
        return;
      }
      if (!auth.id || auth.cancelled) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('O login não está mais ativo.');
        return;
      }
      try {
        const result = await requestJson(config.url, config.token, `/api/auth/${encodeURIComponent(auth.id)}/proxy`, {
          method: 'POST',
          body: {
            path: req.url,
            cookie: req.headers.cookie || '',
            userAgent: req.headers['user-agent'] || '',
          },
          timeoutMs: 20000,
        });
        const headers = {};
        for (const [name, value] of Object.entries(result.headers || {})) {
          if (!['connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(name.toLowerCase())) {
            headers[name] = value;
          }
        }
        if (!headers['content-type'] && !headers['Content-Type']) {
          headers['content-type'] = 'text/html; charset=utf-8';
        }
        res.writeHead(Number(result.status) || 200, headers);
        res.end(result.body || '');
      } catch (error) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Falha no login pelo servidor: ${error.message}`);
      }
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(
          error && error.code === 'EADDRINUSE'
            ? new Error('A porta local 53682 está ocupada. Feche o outro processo e tente novamente.')
            : new Error(`Não foi possível abrir a porta local do login: ${error.message}`),
        );
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(CALLBACK_PORT, '127.0.0.1');
    });

    proxy = {
      close: () =>
        new Promise((resolve) => {
          server.close(() => resolve());
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
        }),
    };
    return proxy;
  }

  async function authConnect(payload) {
    if (activeAuth) return { ok: false, error: 'Já existe uma conexão em andamento.' };

    let config;
    try {
      config = settings();
    } catch (error) {
      return { ok: false, error: error.message };
    }

    const auth = { id: null, cancelled: false, proxy: null };
    activeAuth = auth;
    try {
      auth.proxy = await startCallbackProxy(auth, config);

      let started;
      try {
        const current = settings();
        started = await requestJson(current.url, current.token, '/api/auth', {
          method: 'POST',
          body: payload,
          timeoutMs: 30000,
        });
      } catch (error) {
        return { ok: false, error: error.message };
      }

      if (!started.id || !started.url) return { ok: false, error: 'O servidor não iniciou o login.' };
      auth.id = started.id;

      if (auth.cancelled) {
        await requestJson(config.url, config.token, `/api/auth/${encodeURIComponent(auth.id)}/cancel`, {
          method: 'POST',
        }).catch(() => {});
        return { cancelled: true };
      }

      const url = started.url.replace('://localhost:', '://127.0.0.1:');
      try {
        await openUrl(url);
      } catch {
        await requestJson(config.url, config.token, `/api/auth/${encodeURIComponent(auth.id)}/cancel`, {
          method: 'POST',
        }).catch(() => {});
        return { ok: false, error: 'Não foi possível abrir o navegador.' };
      }

      while (!auth.cancelled) {
        let current;
        try {
          current = settings();
          const state = await requestJson(
            current.url,
            current.token,
            `/api/auth/${encodeURIComponent(auth.id)}`,
            { timeoutMs: 15000 },
          );
          if (state.status === 'done') return { ok: true, remote: state.remote };
          if (state.status === 'error') return { ok: false, error: state.error || 'Não foi possível conectar a conta.' };
          if (state.status === 'cancelled') return { cancelled: true };
        } catch (error) {
          return { ok: false, error: error.message };
        }
        await sleep(700);
      }
      return { cancelled: true };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      await closeProxy(auth.proxy);
      if (activeAuth === auth) activeAuth = null;
    }
  }

  async function cancelAuth() {
    if (!activeAuth) return false;
    activeAuth.cancelled = true;
    const auth = activeAuth;
    if (auth.id) {
      try {
        const config = settings();
        await requestJson(config.url, config.token, `/api/auth/${encodeURIComponent(auth.id)}/cancel`, {
          method: 'POST',
          timeoutMs: 10000,
        });
      } catch {
        // The server may already be gone.
      }
    }
    await closeProxy(auth.proxy);
    return true;
  }

  return {
    authCancel: cancelAuth,
    authConnect,
    ackTransfer,
    cancelTransfer,
    hasActiveAuth: () => Boolean(activeAuth),
    hasActiveTransfer: () => Boolean(activeTransfer),
    list,
    resumeTransfer,
    status,
    transfer,
  };
}

module.exports = {
  RemoteError,
  createRemoteClient,
  normalizeBaseUrl,
  testServer,
};
