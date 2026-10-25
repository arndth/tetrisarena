/* Static file server + credential-holding proxy for the two model backends.
   Zero dependencies, Node 18+ (needs global fetch).

     node server.mjs            -> http://localhost:8787

   Endpoints:
     POST /api/jev    -> https://api.typesafe.ai/v1/systemone          (Jev)
     POST /api/rpt1   -> SAP AI Core /v2/inference/deployments/<id>/predict

   The browser never sees a key. Missing credentials return 503 with a readable
   message, and the game falls back to its local heuristic. */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8787);
/* Bind to loopback by default: the proxy spends YOUR API keys, so it must not be
   reachable from the rest of the network. Set HOST=0.0.0.0 only if you mean it. */
const HOST = process.env.HOST || '127.0.0.1';

/* ---------- .env ---------- */

async function loadEnv() {
  try {
    const raw = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
    console.log('loaded .env');
  } catch {
    /* no .env is fine -- heuristic backend still works */
  }
}

/* ---------- Jev ---------- */

/* Jev can be reached two ways; whichever key is present wins.
     native   TYPESAFE_API_KEY  -> https://api.typesafe.ai/v1/systemone      model "jev-latest"
     via      OPENROUTER_API_KEY -> https://openrouter.ai/api/v1/systemone   model "~typesafe/jev-latest"
   JEV_API_URL / JEV_MODEL override either default. */
function jevRoute() {
  const native = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
  if (native) {
    return {
      via: 'typesafe',
      key: native,
      url: process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone',
      model: process.env.JEV_MODEL || null
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      via: 'openrouter',
      key: process.env.OPENROUTER_API_KEY,
      url: process.env.JEV_API_URL || 'https://openrouter.ai/api/v1/systemone',
      model: process.env.JEV_MODEL || '~typesafe/jev-latest'
    };
  }
  return null;
}

async function callJev(body) {
  const route = jevRoute();
  if (!route) {
    return { status: 503, body: { error: 'no Jev key: set TYPESAFE_API_KEY or OPENROUTER_API_KEY (see .env.example)' } };
  }
  /* the page does not know which route it is on, so the model id is set here */
  if (route.model) body = { ...body, model: route.model };
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + route.key
  };
  if (route.via === 'openrouter') {
    /* optional attribution headers OpenRouter uses for its dashboards */
    headers['http-referer'] = process.env.OPENROUTER_SITE_URL || 'http://localhost:8787';
    headers['x-title'] = process.env.OPENROUTER_APP_TITLE || 'Tetris model players';
  }
  const res = await fetchWithRetry(route.url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 500) }; }
  return { status: res.status, body: parsed };
}

/* Providers rate-limit per model, and a tournament fires several players at
   once -- gemini-2.5-flash-lite returned 429 on 17 of 24 calls in one run. A
   429 or 5xx is transient, so retry briefly (honouring Retry-After) instead of
   handing the turn to the heuristic. */
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30000);
/* rpt.cloud.sap is a throttled test endpoint and reported delay: 27.6s on a
   3-row request, so it needs far more headroom than a chat model. */
const RPT_TIMEOUT_MS = Number(process.env.SAP_RPT_TIMEOUT_MS || 120000);

async function fetchWithRetry(url, init, tries, timeoutMs) {
  const max = tries || 3;
  const budget = timeoutMs || UPSTREAM_TIMEOUT_MS;
  let last = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    /* A provider that takes minutes would stall the game loop, so cap each
       attempt and treat a timeout like any other transient failure. */
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), budget);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctl.signal });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      if (attempt === max) {
        return new Response(JSON.stringify({ error: { message: timedOut
          ? 'upstream timed out after ' + budget + 'ms' : String(err.message || err) } }),
          { status: 504, headers: { 'content-type': 'application/json' } });
      }
      console.log('  retry ' + attempt + '/' + (max - 1) + ' after ' + (timedOut ? 'timeout' : 'network error'));
      await new Promise((r) => setTimeout(r, Math.min(300 * Math.pow(2, attempt - 1), 1500)));
      continue;
    }
    clearTimeout(timer);
    if (res.status !== 429 && res.status < 500) return res;
    last = res;
    if (attempt === max) break;
    const header = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(header) && header > 0
      ? Math.min(header * 1000, 3000)
      : Math.min(300 * Math.pow(2, attempt - 1), 1500);
    console.log('  retry ' + attempt + '/' + (max - 1) + ' after ' + res.status + ' in ' + waitMs + 'ms');
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

/* ---------- any OpenRouter chat model ---------- */

const OR_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

function orHeaders(key) {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer ' + key,
    'http-referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:8787',
    'x-title': process.env.OPENROUTER_APP_TITLE || 'Tetris model players'
  };
}

/* Model ids are never hardcoded -- the list comes from OpenRouter itself, so
   whatever is available to this account is what the UI offers. Cached for an
   hour because it is a few hundred KB of JSON. */
let modelCache = { at: 0, list: null };

async function listModels(force) {
  if (!force && modelCache.list && Date.now() - modelCache.at < 3600e3) {
    return { status: 200, body: modelCache.list };
  }
  const res = await fetch(OR_BASE + '/models');
  if (!res.ok) return { status: res.status, body: { error: 'model list failed: ' + (await res.text()).slice(0, 200) } };
  const json = await res.json();
  const list = (json.data || []).map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context_length,
    promptPrice: m.pricing && Number(m.pricing.prompt),
    completionPrice: m.pricing && Number(m.pricing.completion)
  })).sort((a, b) => a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), list: { models: list } };
  return { status: 200, body: modelCache.list };
}

async function callLlm(body) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { status: 503, body: { error: 'OPENROUTER_API_KEY is not set (see .env.example)' } };
  if (!body || !body.model) return { status: 400, body: { error: 'no model id given' } };
  const res = await fetchWithRetry(OR_BASE + '/chat/completions', {
    method: 'POST',
    headers: orHeaders(key),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 500) }; }
  return { status: res.status, body: parsed };
}

/* ---------- SAP AI Core / RPT-1 ---------- */

let tokenCache = { value: null, expires: 0 };

async function aiCoreToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expires) return tokenCache.value;

  const authUrl = process.env.AICORE_AUTH_URL;
  const id = process.env.AICORE_CLIENT_ID;
  const secret = process.env.AICORE_CLIENT_SECRET;
  if (!authUrl || !id || !secret) {
    throw new Error('AICORE_AUTH_URL / AICORE_CLIENT_ID / AICORE_CLIENT_SECRET are not set');
  }
  const url = authUrl.replace(/\/+$/, '') + '/oauth/token';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('AI Core auth failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const json = await res.json();
  tokenCache = {
    value: json.access_token,
    /* refresh a minute early */
    expires: now + Math.max(60, (json.expires_in || 3600) - 60) * 1000
  };
  return tokenCache.value;
}

/* SAP-RPT-1 is reachable two ways, and they speak different dialects:

     cloud   SAP_RPT_TOKEN  -> POST https://rpt.cloud.sap/api/predict
                              body {rows, index_column}; the target column is
                              implied by whichever cells hold "[PREDICT]"
     aicore  AICORE_*       -> POST <base>/v2/inference/deployments/<id>/predict
                              body {prediction_config:{target_columns}, index_column, rows}

   The picker always sends the aicore-shaped body; this translates on the way out
   and normalises the reply on the way back, so the browser code is dialect-blind
   (same trick as the two Jev routes). */
function rptRoute() {
  if (process.env.SAP_RPT_TOKEN) {
    return {
      via: 'cloud',
      url: process.env.SAP_RPT_URL || 'https://rpt.cloud.sap/api/predict',
      token: process.env.SAP_RPT_TOKEN
    };
  }
  if (process.env.AICORE_BASE_URL && process.env.RPT1_DEPLOYMENT_ID) {
    return {
      via: 'aicore',
      url: process.env.AICORE_BASE_URL.replace(/\/+$/, '')
        + '/v2/inference/deployments/' + process.env.RPT1_DEPLOYMENT_ID + '/predict'
    };
  }
  return null;
}

/* aicore body -> cloud body */
function toCloudBody(body) {
  const out = { rows: body.rows, index_column: body.index_column };
  const want = Number(process.env.SAP_RPT_EXPLANATIONS || 0);
  if (want > 0) {
    out.explanations = { top_column_scores: want, top_relevant_context_rows: want };
  }
  return out;
}

/* Whatever the cloud route answers with, hand the picker the aicore shape:
   {predictions:[{<index>: id, <target>: [{prediction}]}]}. The cloud response
   shape is not documented in the Postman collection, so accept the plausible
   variants and say so loudly if none match. */
function fromCloudBody(raw, body) {
  /* The live API wraps everything in a `prediction` envelope and adds its own
     `delay` / `samplingMetadata` alongside:
       {prediction:{predictions:[...], explanations, metadata, status},
        delay: 27643, samplingMetadata:{strategy:'random', downsampled:false}}
     Unwrap it, but keep the outer telemetry -- the delay and the downsample
     flag both matter when a call takes half a minute. */
  const envelope = raw && typeof raw === 'object' && raw.prediction && typeof raw.prediction === 'object'
    ? raw.prediction : null;
  const outer = raw;
  if (envelope) raw = envelope;

  const index = body.index_column || 'row_id';
  const targets = ((body.prediction_config || {}).target_columns || []).map((t) => t.name);
  const target = targets[0] || 'placement_score';

  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw && raw.predictions) ? raw.predictions
    : Array.isArray(raw && raw.rows) ? raw.rows
    : Array.isArray(raw && raw.data) ? raw.data
    : null;
  if (!list) return { ok: false, raw: raw };

  const predictions = list.map((row) => {
    const out = {};
    out[index] = row[index] != null ? row[index] : row.id;
    for (const name of (targets.length ? targets : [target])) {
      let v = row[name];
      /* already aicore-shaped */
      if (Array.isArray(v)) { out[name] = v; continue; }
      /* {value, confidence} or a bare scalar */
      if (v && typeof v === 'object' && 'prediction' in v) {
        out[name] = [{ prediction: v.prediction, confidence: v.confidence != null ? v.confidence : null }];
        continue;
      }
      if (v && typeof v === 'object' && 'value' in v) {
        out[name] = [{ prediction: v.value, confidence: v.confidence != null ? v.confidence : null }];
        continue;
      }
      if (v === undefined && row.predictions && typeof row.predictions === 'object') {
        v = row.predictions[name];
      }
      if (v !== undefined) out[name] = [{ prediction: v, confidence: null }];
    }
    return out;
  }).filter((row) => Object.keys(row).length > 1);

  if (!predictions.length) return { ok: false, raw: raw };
  const norm = { predictions: predictions, status: { code: 0, message: 'ok' } };
  if (raw && raw.explanations) norm.explanations = raw.explanations;
  if (raw && raw.metadata) norm.metadata = raw.metadata;
  if (outer && typeof outer.delay === 'number') norm.delay = outer.delay;
  if (outer && outer.samplingMetadata) norm.samplingMetadata = outer.samplingMetadata;
  return { ok: true, body: norm };
}

/* The free playground limits prediction requests by RATE, not concurrency:
   x-ratelimit-limit: 5 with an x-ratelimit-reset timestamp, and retry-after: 3
   on breach ("this is a limit of the free playground"). A concurrency cap alone
   still produced 429s, so space requests out instead: one at a time, at least
   SAP_RPT_MIN_INTERVAL_MS apart. That costs latency but removes the 429s, which
   is the right trade when a failed call means the heuristic silently takes the
   turn. */
/* Measured: the burst cap allows ~5 requests per ~15s window, and the quota
   (1000 per ~50min) works out to 3.0s per request. 1.5s spacing still drew
   429s; 3.5s is the first value that ran clean. */
const rptSpacingMs = Number(process.env.SAP_RPT_MIN_INTERVAL_MS || 3500);
let rptChain = Promise.resolve();
let rptLastStart = 0;
/* Learned from the response headers. There are two limits: a short burst cap
   (x-ratelimit-limit: 5 on a 429, retry-after: 3) and a sustained quota
   (x-ratelimit-limit: 1000 resetting in ~50min on a 200). Reading them beats
   guessing a spacing. */
const rptLimit = { limit: null, remaining: null, resetAt: null };

function rptNoteHeaders(res) {
  const num = (k) => { const v = Number(res.headers.get(k)); return Number.isFinite(v) ? v : null; };
  const lim = num('x-ratelimit-limit');
  const rem = num('x-ratelimit-remaining');
  const reset = num('x-ratelimit-reset');
  if (lim != null) rptLimit.limit = lim;
  if (rem != null) rptLimit.remaining = rem;
  if (reset != null) rptLimit.resetAt = reset * 1000;
}

function rptSchedule(task) {
  const run = async () => {
    /* quota exhausted -> wait for the published reset rather than burn retries */
    if (rptLimit.remaining === 0 && rptLimit.resetAt && rptLimit.resetAt > Date.now()) {
      const until = Math.min(rptLimit.resetAt - Date.now() + 250, 60000);
      console.log('  rpt quota exhausted, waiting ' + Math.round(until / 1000) + 's for reset');
      await new Promise((r) => setTimeout(r, until));
    }
    const wait = Math.max(0, rptLastStart + rptSpacingMs - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    rptLastStart = Date.now();
    return task();
  };
  /* keep the chain alive even if a task rejects */
  const result = rptChain.then(run, run);
  rptChain = result.then(() => undefined, () => undefined);
  return result;
}

async function callRpt1(body) {
  const route = rptRoute();
  if (!route) {
    return { status: 503, body: { error: 'no SAP-RPT-1 route: set SAP_RPT_TOKEN, '
      + 'or AICORE_BASE_URL + RPT1_DEPLOYMENT_ID (see .env.example)' } };
  }

  if (route.via === 'cloud') {
    const res = await rptSchedule(() => fetchWithRetry(route.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + route.token },
      body: JSON.stringify(toCloudBody(body))
    }, 4, RPT_TIMEOUT_MS));
    rptNoteHeaders(res);
    const text = await res.text();
    let raw;
    try { raw = JSON.parse(text); } catch { raw = null; }
    if (!res.ok) {
      return { status: res.status, body: raw || { error: text.slice(0, 400) } };
    }
    const conv = fromCloudBody(raw, body);
    if (!conv.ok) {
      /* Better a loud, inspectable failure than a silently wrong move. */
      console.log('  rpt cloud: unrecognised response shape: ' + JSON.stringify(raw).slice(0, 400));
      return { status: 502, body: { error: 'unrecognised rpt.cloud.sap response shape',
        keys: raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw, sample: text.slice(0, 300) } };
    }
    return { status: 200, body: conv.body };
  }

  const headers = {
    'content-type': 'application/json',
    'ai-resource-group': process.env.AICORE_RESOURCE_GROUP || 'default'
  };
  /* A locally served open-weights RPT-1 needs no OAuth; only do the token
     exchange when AI Core credentials are actually configured. */
  if (process.env.AICORE_CLIENT_ID || process.env.AICORE_CLIENT_SECRET || process.env.AICORE_AUTH_URL) {
    try {
      headers.authorization = 'Bearer ' + (await aiCoreToken());
    } catch (err) {
      return { status: 503, body: { error: String(err.message || err) } };
    }
  }
  const res = await fetchWithRetry(route.url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 500) }; }
  return { status: res.status, body: parsed };
}

/* ---------- static files ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml'
};

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS'
};

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }

  if (urlPath === '/api/models') {
    /* ?refresh=1 busts the hour-long cache -- needed after changing what this
       endpoint returns, or to pick up newly released models mid-session. */
    const force = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1';
    const out = await listModels(force);
    res.writeHead(out.status, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
    return;
  }

  if (urlPath === '/api/jev' || urlPath === '/api/rpt1' || urlPath === '/api/llm') {
    if (req.method !== 'POST') { res.writeHead(405, CORS).end(); return; }
    let out;
    try {
      const body = JSON.parse(await readBody(req));
      const t0 = Date.now();
      out = urlPath === '/api/jev' ? await callJev(body)
        : urlPath === '/api/rpt1' ? await callRpt1(body)
        : await callLlm(body);
      console.log(req.method, urlPath, (body.model || '') + ' ' + out.status, Date.now() - t0 + 'ms');
    } catch (err) {
      out = { status: 502, body: { error: String(err.message || err) } };
      console.error(urlPath, err.message || err);
    }
    res.writeHead(out.status, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
    return;
  }

  if (urlPath === '/api/health') {
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      jev: Boolean(jevRoute()),
      jevVia: jevRoute() ? jevRoute().via : null,
      jevUrl: jevRoute() ? jevRoute().url : null,
      jevModel: jevRoute() ? (jevRoute().model || 'sent by page') : null,
      rpt1: Boolean(rptRoute()),
      rpt1Via: rptRoute() ? rptRoute().via : null,
      rpt1Url: rptRoute() ? rptRoute().url : null,
      rpt1Auth: rptRoute()
        ? (rptRoute().via === 'cloud' ? 'bearer token'
          : (process.env.AICORE_CLIENT_ID ? 'ai-core oauth' : 'none (local deployment)'))
        : null
    }));
    return;
  }

  await serveStatic(req, res, urlPath);
});

await loadEnv();
server.listen(PORT, HOST, () => {
  console.log('tetris on http://' + (HOST === '127.0.0.1' ? 'localhost' : HOST) + ':' + PORT);
  const jr = jevRoute();
  console.log('  jev  credentials: ' + (jr ? 'present via ' + jr.via + ' -> ' + jr.url : 'missing'));
  const rr = rptRoute();
  console.log('  rpt1 route:       ' + (rr ? rr.via + ' -> ' + rr.url : 'missing'));
});
