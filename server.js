'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { createEngine } = require('./lib/engine');

const TOKEN = String(process.env.CM_TOKEN || '').trim();
const HOST = process.env.CM_HOST || '0.0.0.0';
const PORT = Number(process.env.CM_PORT || 8787);
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_KEEP_MS = 5 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const MAX_PROXY_BODY = 512 * 1024;

if (TOKEN.length < 16) {
  console.error('CM_TOKEN ausente ou curto demais. Use um token com pelo menos 16 caracteres.');
  process.exit(1);
}

const expectedToken = crypto.createHash('sha256').update(TOKEN).digest();
const engine = createEngine({ configPath: null });
let transferState = null;
let authState = null;

function isAuthorized(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const supplied = crypto
    .createHash('sha256')
    .update(match ? match[1].trim() : '')
    .digest();
  return crypto.timingSafeEqual(expectedToken, supplied);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Corpo da requisição grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function publicTransfer() {
  if (!transferState) return null;
  const state = transferState;
  return {
    id: state.id,
    status: state.status,
    srcRemote: state.srcRemote,
    destRemote: state.destRemote,
    srcType: state.srcType,
    destType: state.destType,
    itemIndex: state.itemIndex,
    itemCount: state.itemCount,
    itemName: state.itemName,
    isDir: state.isDir,
    stats: state.stats,
    completed: state.completed,
    total: state.total,
    failed: state.failed,
    backupPath: state.backupPath,
    elapsedMs: state.elapsedMs,
    error: state.error,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

function publicAuth(state) {
  if (!state) return null;
  return {
    id: state.id,
    status: state.status,
    remote: state.remote || null,
    error: state.error || null,
  };
}

function cleanupAuthTimer(state) {
  if (state && state.timeout) clearTimeout(state.timeout);
  if (state && state.keepTimer) clearTimeout(state.keepTimer);
}

function startAuth(payload) {
  if (authState && (authState.status === 'starting' || authState.status === 'waiting')) {
    throw new Error('Já existe um login em andamento.');
  }
  if (authState) cleanupAuthTimer(authState);

  const type = payload.type;
  if (type !== 'drive' && type !== 'onedrive') throw new Error('Tipo de conta inválido.');

  const state = {
    id: crypto.randomUUID(),
    status: 'starting',
    url: null,
    remote: null,
    error: null,
    handle: null,
    timeout: null,
    keepTimer: null,
  };
  authState = state;

  let resolveUrl;
  let urlResolved = false;
  const urlPromise = new Promise((resolve) => {
    resolveUrl = resolve;
  });

  const handle = engine.startAuth(
    {
      type,
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
    },
    {
      onUrl: (url) => {
        if (authState !== state) return;
        state.url = url;
        state.status = 'waiting';
        if (!urlResolved) {
          urlResolved = true;
          resolveUrl(url);
        }
      },
    },
  );
  state.handle = handle;

  state.timeout = setTimeout(() => {
    if (authState !== state) return;
    if (state.status === 'starting' || state.status === 'waiting') {
      try {
        handle.cancel();
      } catch {
        // Already gone.
      }
      state.status = 'error';
      state.error = 'O login demorou demais para começar.';
    }
  }, AUTH_TIMEOUT_MS);

  handle.promise
    .then((result) => {
      if (authState !== state) return;
      if (state.status === 'cancelled') return;
      if (result && result.ok && result.remote) {
        state.status = 'done';
        state.remote = result.remote;
        state.error = null;
      } else if (result && result.cancelled) {
        state.status = 'cancelled';
      } else {
        state.status = 'error';
        state.error = (result && result.error) || 'Não foi possível conectar a conta.';
      }
      state.handle = null;
      state.finishedAt = Date.now();
      if (state.timeout) clearTimeout(state.timeout);
      if (state.keepTimer) clearTimeout(state.keepTimer);
      state.keepTimer = setTimeout(() => {
        if (authState === state) authState = null;
      }, AUTH_KEEP_MS);
    })
    .catch((error) => {
      if (authState !== state) return;
      if (state.status === 'cancelled') return;
      state.status = 'error';
      state.error = error.message || 'Não foi possível conectar a conta.';
      state.handle = null;
    });

  return { state, urlPromise };
}

function cancelAuth(state) {
  if (!state) return;
  state.status = 'cancelled';
  state.error = null;
  if (state.handle) {
    try {
      state.handle.cancel();
    } catch {
      // Already gone.
    }
  }
  if (state.timeout) clearTimeout(state.timeout);
  if (state.keepTimer) clearTimeout(state.keepTimer);
  state.keepTimer = setTimeout(() => {
    if (authState === state) authState = null;
  }, AUTH_KEEP_MS);
}

function proxyToRclone({ path: requestPath, cookie, userAgent }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(String(requestPath || '/'), 'http://127.0.0.1:53682');
    } catch {
      reject(new Error('Caminho de login inválido.'));
      return;
    }
    if (target.origin !== 'http://127.0.0.1:53682') {
      reject(new Error('Caminho de login inválido.'));
      return;
    }

    const headers = { host: '127.0.0.1:53682' };
    if (cookie) headers.cookie = cookie;
    if (userAgent) headers['user-agent'] = userAgent;

    const request = http.request(
      target,
      { method: 'GET', headers, timeout: 15000 },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_PROXY_BODY) {
            request.destroy(new Error('Resposta de login grande demais.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode || 502,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('O login não respondeu a tempo.')));
    request.on('error', reject);
    request.end();
  });
}

function startTransfer(payload) {
  if (transferState && transferState.status === 'running') {
    const error = new Error('Já existe uma transferência em andamento.');
    error.statusCode = 409;
    error.transferId = transferState.id;
    throw error;
  }

  const srcRemote = payload.srcRemote;
  const destRemote = payload.destRemote;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const state = {
    id: crypto.randomUUID(),
    status: 'running',
    srcRemote,
    destRemote,
    srcType: null,
    destType: null,
    itemIndex: 0,
    itemCount: items.length,
    itemName: '',
    isDir: false,
    stats: null,
    completed: 0,
    total: items.length,
    failed: null,
    backupPath: null,
    elapsedMs: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    handle: null,
  };
  transferState = state;

  engine
    .status()
    .then((status) => {
      if (transferState !== state) return;
      const source = (status.remotes || []).find((remote) => remote.name === srcRemote);
      const destination = (status.remotes || []).find((remote) => remote.name === destRemote);
      state.srcType = source ? source.type : null;
      state.destType = destination ? destination.type : null;
    })
    .catch(() => {});

  const handle = engine.startTransfer(payload, {
    onProgress: (event) => {
      if (transferState !== state) return;
      if (event.phase === 'item') {
        state.itemIndex = event.itemIndex || 0;
        state.itemCount = event.itemCount || state.itemCount;
        state.itemName = event.itemName || '';
        state.isDir = Boolean(event.isDir);
        state.stats = null;
      } else if (event.phase === 'stats') {
        state.stats = event.stats || null;
      }
    },
  });
  state.handle = handle;

  handle.promise
    .then((result) => {
      if (transferState !== state) return;
      state.handle = null;
      state.completed = result.completed || 0;
      state.total = result.total || state.total;
      state.failed = result.failed || null;
      state.backupPath = result.backupPath || null;
      state.elapsedMs = result.elapsedMs || 0;
      state.error = result.error || null;
      state.status = result.cancelled ? 'cancelled' : result.ok ? 'done' : 'error';
      state.finishedAt = Date.now();
    })
    .catch((error) => {
      if (transferState !== state) return;
      state.handle = null;
      state.status = 'error';
      state.error = error.message || 'A transferência falhou.';
      state.finishedAt = Date.now();
    });

  return state;
}

async function route(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathName = url.pathname;

  if (pathName === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'Token inválido ou ausente.' });
    return;
  }

  if (pathName === '/api/status' && req.method === 'GET') {
    const status = await engine.status({ refresh: url.searchParams.get('refresh') === '1' });
    sendJson(res, 200, { ...status, transfer: publicTransfer() });
    return;
  }

  if (pathName === '/api/list' && req.method === 'GET') {
    const result = await engine.list(url.searchParams.get('remote'), url.searchParams.get('path') || '');
    sendJson(res, 200, result);
    return;
  }

  if (pathName === '/api/transfers' && req.method === 'POST') {
    const payload = await readJson(req);
    try {
      const state = startTransfer(payload);
      sendJson(res, 202, { id: state.id });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, transferId: error.transferId });
    }
    return;
  }

  if (pathName === '/api/transfers/current' && req.method === 'GET') {
    sendJson(res, 200, { transfer: publicTransfer() });
    return;
  }

  const transferMatch = /^\/api\/transfers\/([^/]+)(?:\/(cancel|ack))?$/.exec(pathName);
  if (transferMatch) {
    const id = decodeURIComponent(transferMatch[1]);
    const action = transferMatch[2] || '';
    if (!transferState || transferState.id !== id) {
      sendJson(res, 404, { error: 'Transferência não encontrada.' });
      return;
    }
    if (!action && req.method === 'GET') {
      sendJson(res, 200, publicTransfer());
      return;
    }
    if (action === 'cancel' && req.method === 'POST') {
      if (transferState.status === 'running' && transferState.handle) {
        transferState.handle.cancel();
      }
      sendJson(res, 202, { ok: true });
      return;
    }
    if (action === 'ack' && req.method === 'POST') {
      if (transferState.status === 'running') {
        sendJson(res, 409, { error: 'A transferência ainda está em andamento.' });
        return;
      }
      transferState = null;
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'Método não permitido.' });
    return;
  }

  if (pathName === '/api/auth' && req.method === 'POST') {
    const payload = await readJson(req);
    try {
      const { state, urlPromise } = startAuth(payload);
      const outcome = await Promise.race([
        urlPromise.then((authUrl) => ({ authUrl })),
        state.handle.promise.then((result) => ({ result })),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 20000)),
      ]);

      if (outcome.authUrl) {
        sendJson(res, 202, { id: state.id, url: outcome.authUrl });
        return;
      }
      if (outcome.timeout) {
        cancelAuth(state);
        sendJson(res, 504, { error: 'O servidor não conseguiu iniciar o login a tempo.' });
        return;
      }
      if (outcome.result && outcome.result.ok) {
        sendJson(res, 200, { id: state.id, remote: outcome.result.remote });
        return;
      }
      sendJson(res, 400, {
        error: (outcome.result && outcome.result.error) || 'Não foi possível iniciar o login.',
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  const authMatch = /^\/api\/auth\/([^/]+)(?:\/(cancel|proxy))?$/.exec(pathName);
  if (authMatch) {
    const id = decodeURIComponent(authMatch[1]);
    const action = authMatch[2] || '';
    if (!authState || authState.id !== id) {
      sendJson(res, 404, { error: 'Login não encontrado.' });
      return;
    }
    if (!action && req.method === 'GET') {
      sendJson(res, 200, publicAuth(authState));
      return;
    }
    if (action === 'cancel' && req.method === 'POST') {
      cancelAuth(authState);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'proxy' && req.method === 'POST') {
      if (authState.status !== 'waiting') {
        sendJson(res, 409, { error: 'O login não está aguardando o navegador.' });
        return;
      }
      const payload = await readJson(req);
      try {
        const result = await proxyToRclone({
          path: payload.path,
          cookie: payload.cookie,
          userAgent: payload.userAgent,
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Falha ao encaminhar o login.' });
      }
      return;
    }
    sendJson(res, 405, { error: 'Método não permitido.' });
    return;
  }

  sendJson(res, 404, { error: 'Rota não encontrada.' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || 'Erro interno do servidor.' });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.error(`Cloud Migrator server em http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.error(`Encerrando (${signal})`);
  if (transferState && transferState.handle) {
    try {
      transferState.handle.cancel();
    } catch {
      // Already gone.
    }
  }
  if (authState && authState.handle) {
    try {
      authState.handle.cancel();
    } catch {
      // Already gone.
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
