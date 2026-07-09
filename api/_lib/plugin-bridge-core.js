const MAX_ACTIONS = 150;
const MAX_RESULTS = 150;
const MAX_CONTEXT_BYTES = 900_000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const CONNECTED_TTL_MS = 45 * 1000;
const REQUIRED_PLUGIN_VERSION = '3.5';
const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_PREFIX = 'rotex:bridge:';

function bridgeInstanceId() {
  if (!global.__ROTEX_WEB_PLUGIN_INSTANCE_ID) {
    global.__ROTEX_WEB_PLUGIN_INSTANCE_ID = Math.random().toString(36).slice(2, 10);
  }
  return global.__ROTEX_WEB_PLUGIN_INSTANCE_ID;
}

function bridgeStorageKind() {
  return REDIS_URL && REDIS_TOKEN ? 'redis' : 'memory';
}

function sessions() {
  if (!global.__ROTEX_WEB_PLUGIN_SESSIONS) {
    global.__ROTEX_WEB_PLUGIN_SESSIONS = new Map();
  }
  return global.__ROTEX_WEB_PLUGIN_SESSIONS;
}

function cleanCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 18);
}

async function redisCommand(command, ...args) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });
  if (!response.ok) throw new Error(`redis_${response.status}`);
  const data = await response.json();
  return data?.result;
}

async function loadDurableSession(key, now) {
  const raw = await redisCommand('GET', REDIS_PREFIX + key);
  if (!raw) return null;
  const session = JSON.parse(raw);
  session.code = key;
  session.actions = Array.isArray(session.actions) ? session.actions : [];
  session.results = Array.isArray(session.results) ? session.results : [];
  session.updatedAt = now;
  session._storage = 'redis';
  return session;
}

async function saveSession(session) {
  if (!session || session._storage !== 'redis') return;
  const clone = { ...session };
  delete clone._storage;
  await redisCommand('SETEX', REDIS_PREFIX + session.code, String(Math.ceil(SESSION_TTL_MS / 1000)), JSON.stringify(clone));
}

async function getSession(code) {
  const key = cleanCode(code);
  if (!key || key.length < 4) return null;
  const now = Date.now();
  if (bridgeStorageKind() === 'redis') {
    try {
      const durable = await loadDurableSession(key, now);
      if (durable) return durable;
      return {
        _storage: 'redis',
        code: key,
        createdAt: now,
        updatedAt: now,
        webSeenAt: 0,
        pluginSeenAt: 0,
        context: null,
        actions: [],
        results: [],
      };
    } catch {
      // If durable storage is misconfigured or temporarily unavailable, keep
      // the bridge usable instead of breaking the website/plugin handshake.
    }
  }
  const store = sessions();
  for (const [id, session] of store) {
    if (now - (session.updatedAt || 0) > SESSION_TTL_MS) store.delete(id);
  }
  if (!store.has(key)) {
    store.set(key, {
      code: key,
      createdAt: now,
      updatedAt: now,
      webSeenAt: 0,
      pluginSeenAt: 0,
      context: null,
      actions: [],
      results: [],
    });
  }
  const session = store.get(key);
  session.updatedAt = now;
  session._storage = 'memory';
  return session;
}

function send(res, status, body) {
  res.status(status).json(body);
}

function safeJson(value, fallback = {}) {
  if (!value || typeof value !== 'object') return fallback;
  return value;
}

function bridgeMeta(session, now) {
  const storage = session._storage || bridgeStorageKind();
  return {
    bridgeStorage: storage,
    bridgeInstance: bridgeInstanceId(),
    bridgeWarning: storage === 'memory' ? 'memory_bridge_not_durable' : '',
    requiredPluginVersion: REQUIRED_PLUGIN_VERSION,
    pluginConnected: now - (session.pluginSeenAt || 0) < CONNECTED_TTL_MS,
    webConnected: now - (session.webSeenAt || 0) < CONNECTED_TTL_MS,
    hasContext: Boolean(session.context),
    contextAt: session.contextAt || 0,
    pendingActions: session.actions.length,
    queued: session.actions.length,
    resultCount: session.results.length,
    pluginVersion: session.pluginVersion || '',
    gameName: session.gameName || '',
  };
}

function ok(session, now, extra = {}) {
  return {
    ok: true,
    code: session.code,
    ...bridgeMeta(session, now),
    ...extra,
  };
}

async function sendOk(res, session, now, extra = {}) {
  await saveSession(session);
  return send(res, 200, ok(session, now, extra));
}

async function handlePluginBridge(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const isPost = req.method === 'POST';
  if (req.method !== 'GET' && !isPost) return send(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = isPost ? safeJson(req.body) : {};
  const op = String((isPost ? body.op : req.query?.op) || 'status');
  const code = cleanCode(isPost ? body.code : req.query?.code);
  const session = await getSession(code);
  if (!session) return send(res, 400, { ok: false, error: 'bad_code' });

  const now = Date.now();
  try {
    if (op === 'web_hello') {
      session.webSeenAt = now;
      return sendOk(res, session, now);
    }

    if (op === 'plugin_hello' || op === 'heartbeat') {
      session.pluginSeenAt = now;
      session.pluginVersion = body.pluginVersion || session.pluginVersion || '';
      session.gameName = body.gameName || session.gameName || '';
      return sendOk(res, session, now);
    }

    if (op === 'context') {
      if (isPost) {
        session.pluginSeenAt = now;
        const context = safeJson(body.context, body);
        const serialized = JSON.stringify(context);
        if (Buffer.byteLength(serialized) > MAX_CONTEXT_BYTES) {
          return send(res, 413, { ok: false, error: 'context_too_large' });
        }
        session.context = context;
        session.contextAt = now;
        session.pluginVersion = context.pluginVersion || session.pluginVersion || '';
        session.gameName = context.gameName || session.gameName || '';
        return sendOk(res, session, now);
      }
      session.webSeenAt = now;
      return sendOk(res, session, now, {
        context: session.context || null,
      });
    }

    if (op === 'queue') {
      if (!isPost) return send(res, 405, { ok: false, error: 'post_required' });
      session.webSeenAt = now;
      const actions = Array.isArray(body.actions) ? body.actions : [];
      for (const action of actions.slice(0, 75)) {
        if (action && typeof action === 'object') session.actions.push(action);
      }
      session.actions = session.actions.slice(-MAX_ACTIONS);
      return sendOk(res, session, now);
    }

    if (op === 'actions') {
      session.pluginSeenAt = now;
      const action = session.actions.shift() || null;
      return sendOk(res, session, now, { action });
    }

    if (op === 'result') {
      if (!isPost) return send(res, 405, { ok: false, error: 'post_required' });
      session.pluginSeenAt = now;
      const result = safeJson(body.result, body);
      session.results.push({ ...result, t: now });
      session.results = session.results.slice(-MAX_RESULTS);
      return sendOk(res, session, now);
    }

    if (op === 'results') {
      session.webSeenAt = now;
      const since = Number(req.query?.since || 0);
      const results = session.results.filter((item) => !since || Number(item.t || 0) > since);
      return sendOk(res, session, now, {
        results,
        last: session.results.length ? session.results[session.results.length - 1].t : 0,
      });
    }

    if (op === 'disconnect') {
      session.pluginSeenAt = 0;
      session.actions.length = 0;
      return sendOk(res, session, now);
    }

    return sendOk(res, session, now);
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message || 'bridge_error' });
  }
}

module.exports = { handlePluginBridge };
