/* UI wiring: player cards, controls, render loop, keyboard. */
(function (global) {
  'use strict';

  const T = global.Tetris;
  const F = global.Features;
  const P = global.Pickers;
  const R = global.Render;
  const A = global.Arena;

  global.AIConfig = { candidateLimit: 10, jevModel: 'jev-latest', eurPerCu: 1 };

  const $ = (id) => document.getElementById(id);
  const els = {
    arena: $('arena'), seed: $('seed'), newSeed: $('newSeed'),
    speed: $('speed'), candidates: $('candidates'),
    run: $('run'), reset: $('reset'), addPlayer: $('addPlayer'),
    log: $('log'), banner: $('banner'), models: $('modelList'), health: $('health'),
    costPlayers: $('costPlayers'), costTotals: $('costTotals'),
    costRates: $('costRates'), costEfficiency: $('costEfficiency'),
    costSap: $('costSap'), eurPerCu: $('eurPerCu')
  };

  const players = [];
  const config = { speed: 'normal', candidateLimit: 10 };
  let running = false;
  let modelIds = [];
  let announced = false;
  let lastCostPaint = 0;
  global.ModelPrices = {};

  /* ---------- logging ---------- */

  function log(msg, kind) {
    const line = document.createElement('div');
    line.className = 'log-line' + (kind ? ' ' + kind : '');
    const t = new Date();
    line.innerHTML = '<span class="log-time">'
      + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0')
      + '</span>' + msg;
    els.log.appendChild(line);
    while (els.log.childElementCount > 120) els.log.removeChild(els.log.firstChild);
    els.log.scrollTop = els.log.scrollHeight;
  }

  /* ---------- player cards ---------- */

  function cellSize() {
    const n = players.length;
    if (n <= 1) return 26;
    if (n === 2) return 22;
    if (n <= 4) return 17;
    return 13;
  }

  function buildCard(player) {
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const nameEl = document.createElement('input');
    nameEl.className = 'name';
    nameEl.value = player.name;
    nameEl.addEventListener('input', () => { player.name = nameEl.value; });
    const del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '✕';
    del.title = 'remove player';
    del.addEventListener('click', () => removePlayer(player));
    head.appendChild(nameEl);
    head.appendChild(del);

    const backend = document.createElement('select');
    const human = document.createElement('option');
    human.value = 'human'; human.textContent = 'You (keyboard)';
    backend.appendChild(human);
    for (const picker of P.list()) {
      const o = document.createElement('option');
      o.value = picker.id; o.textContent = picker.label;
      backend.appendChild(o);
    }
    backend.value = player.pickerId;
    backend.addEventListener('change', () => {
      player.pickerId = backend.value;
      player.plan = null; player.serial++;
      syncModelField(player);
      log(player.name + ' → ' + backend.options[backend.selectedIndex].textContent, 'dim');
      paint(player);
    });

    const modelWrap = document.createElement('div');
    modelWrap.className = 'model-wrap';
    const modelInput = document.createElement('input');
    modelInput.className = 'model';
    modelInput.setAttribute('list', 'modelList');
    modelInput.placeholder = 'model id (type to search)';
    modelInput.addEventListener('change', () => {
      player.model = modelInput.value.trim() || null;
      log(player.name + ' model = ' + (player.model || '(none)'), 'dim');
    });
    const modelSelect = document.createElement('select');
    modelSelect.className = 'model';
    modelSelect.addEventListener('change', () => {
      player.model = modelSelect.value;
      log(player.name + ' variant = ' + player.model, 'dim');
    });
    modelWrap.appendChild(modelInput);
    modelWrap.appendChild(modelSelect);

    const canvas = document.createElement('canvas');
    const stats = document.createElement('div');
    stats.className = 'pstats';
    const status = document.createElement('div');
    status.className = 'pstatus';
    const note = document.createElement('div');
    note.className = 'pnote';

    card.appendChild(head);
    card.appendChild(backend);
    card.appendChild(modelWrap);
    card.appendChild(canvas);
    card.appendChild(stats);
    card.appendChild(status);
    card.appendChild(note);

    player.el = { card: card, backend: backend, modelWrap: modelWrap, modelInput: modelInput,
      modelSelect: modelSelect, canvas: canvas, stats: stats, status: status, note: note, name: nameEl };
    els.arena.appendChild(card);
    syncModelField(player);
    return card;
  }

  function syncModelField(player) {
    const picker = P.registry[player.pickerId];
    const needs = picker && picker.needsModel;
    const el = player.el;
    el.modelWrap.style.display = needs ? 'block' : 'none';
    if (!needs) return;

    /* a fixed variant list (SAP-RPT-1) gets a select; open model ids get a
       searchable text field backed by the live OpenRouter datalist */
    const variants = typeof picker.variants === 'function' ? picker.variants() : null;
    const fixed = variants && variants.length;
    el.modelSelect.style.display = fixed ? 'block' : 'none';
    el.modelInput.style.display = fixed ? 'none' : 'block';

    if (fixed) {
      if (el.modelSelect.childElementCount !== variants.length) {
        el.modelSelect.innerHTML = '';
        for (const v of variants) {
          const o = document.createElement('option');
          o.value = v.id; o.textContent = v.label;
          el.modelSelect.appendChild(o);
        }
      }
      const dflt = typeof picker.defaultModel === 'function' ? picker.defaultModel() : variants[0].id;
      if (!player.model || !variants.some((v) => v.id === player.model)) player.model = dflt;
      el.modelSelect.value = player.model;
      return;
    }

    if (!player.model || player.model.indexOf('/') < 0) player.model = defaultModel();
    el.modelInput.value = player.model || '';
  }

  function defaultModel() {
    if (!modelIds.length) return null;
    const prefer = ['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4.5', 'anthropic/claude-opus-5'];
    for (const id of prefer) if (modelIds.includes(id)) return id;
    const anth = modelIds.find((m) => m.startsWith('anthropic/'));
    return anth || modelIds[0];
  }

  function addPlayer(opts) {
    const player = A.createPlayer(opts || {});
    players.push(player);
    buildCard(player);
    A.resetPlayer(player, currentSeed());
    relayout();
    paint(player);
    return player;
  }

  function removePlayer(player) {
    const i = players.indexOf(player);
    if (i < 0) return;
    players.splice(i, 1);
    player.el.card.remove();
    relayout();
    updateBanner();
  }

  function relayout() {
    els.arena.className = 'arena cols-' + Math.min(players.length, 4);
    els.addPlayer.disabled = players.length >= 6;
  }

  /* ---------- rendering ---------- */

  function paint(player, extra) {
    const g = player.game;
    if (!g) return;
    R.drawBoard(player.el.canvas, g, {
      cellSize: cellSize(),
      ghost: A.isHuman(player),
      plan: A.isHuman(player) ? null : player.plan
    });
    const picker = P.registry[player.pickerId];
    player.el.stats.innerHTML =
      '<span><b>' + g.lines + '</b> lines</span>'
      + '<span><b>' + g.score.toLocaleString() + '</b> pts</span>'
      + '<span><b>' + g.pieces + '</b> pieces</span>'
      + (picker && picker.needsProxy
        ? '<span><b>' + (player.stats.decisions ? Math.round(player.stats.totalMs / player.stats.decisions) : 0)
          + '</b> ms avg</span><span class="' + (player.stats.fallbacks ? 'warnx' : '')
          + '"><b>' + player.stats.fallbacks + '</b> fallbacks</span>'
        : '');
    const now = g.active ? g.active.type : '—';
    player.el.status.innerHTML = '<span class="dim">now</span> ' + now
      + ' <span class="dim">next</span> ' + g.queue.slice(0, 3).join(' ')
      + ' · ' + (g.over ? '<span class="warnx">' + player.status + '</span>' : player.status);
    player.el.note.textContent = player.lastNote || '';
    if (extra && extra.result) {
      const f = extra.result.placement.features;
      log('<b>' + player.name + '</b> ' + extra.type + ' → rot ' + f.rotation + ', col ' + f.column
        + (f.linesCleared ? ', <span class="good">clears ' + f.linesCleared + '</span>' : '')
        + ' <span class="dim">(' + Math.round(extra.ms) + 'ms) ' + extra.result.note + '</span>',
        extra.result.fallback ? 'warn' : '');
    }
  }

  /* ---------- cost rails ---------- */

  function money(v) {
    if (!v) return '$0.00';
    if (v < 0.01) return '$' + v.toFixed(5);
    if (v < 1) return '$' + v.toFixed(4);
    return '$' + v.toFixed(2);
  }

  function eur(v) {
    if (!v) return '€0.00';
    if (v < 0.01) return '€' + v.toFixed(5);
    if (v < 1) return '€' + v.toFixed(4);
    return '€' + v.toFixed(2);
  }

  function tok(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function backendLabel(player) {
    if (A.isHuman(player)) return 'keyboard';
    const picker = P.registry[player.pickerId];
    if (player.pickerId === 'llm') return player.model || '(no model)';
    return picker ? picker.label.replace(/\s*\(.*\)$/, '') : player.pickerId;
  }

  function paintCosts() {
    const totals = A.sumLedgers(players);
    const grand = A.totalCost(totals);
    const maxSpend = Math.max.apply(null, [1e-9].concat(players.map((p) => A.totalCost(p.cost))));

    /* left rail: one row per player */
    els.costPlayers.innerHTML = players.map((player) => {
      const led = player.cost;
      const spend = A.totalCost(led);
      const pieces = player.game ? Math.max(player.game.pieces - 1, 0) : 0;
      const local = !P.registry[player.pickerId] || !P.registry[player.pickerId].needsProxy;
      return '<div class="costrow">'
        + '<div class="who"><span>' + escapeHtml(player.name) + '</span><em>'
        + (local ? 'free' : money(spend)) + '</em></div>'
        + '<div class="mini">' + escapeHtml(backendLabel(player)) + '</div>'
        + (local ? '<div class="mini">no API calls — runs locally</div>'
          : '<div class="mini">' + led.calls + ' calls · '
            + (led.inputCells ? tok(led.inputCells + led.predictedCells) + ' cells'
              : tok(led.promptTokens + led.completionTokens) + ' tok')
            + (pieces && spend ? ' · ' + money(spend / pieces) + '/piece' : '')
            + (led.failedCalls ? ' · <span class="warnx">' + led.failedCalls + ' failed</span>' : '')
            + '</div>'
            + (led.sapEur
              ? '<div class="mini theo">playground free · ' + eur(led.sapEur) + ' on BTP'
                + (pieces ? ' (' + eur(led.sapEur / pieces) + '/piece)' : '') + '</div>'
              : '')
            + '<div class="bar"><i style="width:' + Math.round(100 * spend / maxSpend) + '%"></i></div>')
        + '</div>';
    }).join('') || '<div class="mini">no players</div>';

    /* left rail bottom: cost per line cleared, the metric that actually matters */
    const ranked = players
      .filter((p) => !A.isHuman(p) && p.game && p.game.lines > 0)
      .map((p) => ({ p: p, perLine: A.totalCost(p.cost) / p.game.lines }))
      .sort((a, b) => a.perLine - b.perLine);
    els.costEfficiency.innerHTML = ranked.length
      ? ranked.map((r) => '<div class="kv"><span>' + escapeHtml(r.p.name) + '</span><span>'
          + (r.perLine === 0 ? 'free' : money(r.perLine)) + ' / line</span></div>').join('')
      : '<div class="freecap">No lines cleared yet.</div>';

    /* right rail: session totals */
    const inTok = totals.promptTokens, outTok = totals.completionTokens;
    els.costTotals.innerHTML =
      '<div class="big' + (grand ? '' : ' zero') + '">' + money(grand) + '</div>'
      + '<div class="freecap" style="margin-bottom:9px;">'
      + (totals.cost ? 'billed by OpenRouter' : 'nothing billed yet')
      + (totals.estimated ? ' + ' + money(totals.estimated) + ' estimated from price list' : '')
      + '</div>'
      + '<div class="sep"></div>'
      + '<div class="kv"><span>API calls</span><span>' + totals.calls + '</span></div>'
      + '<div class="kv"><span>billed</span><span>' + totals.billedCalls + '</span></div>'
      + (totals.failedCalls ? '<div class="kv"><span>failed (unbilled)</span><span class="warnx">'
          + totals.failedCalls + '</span></div>' : '')
      + (totals.unpricedCalls ? '<div class="kv"><span>RPT-1 (no usage)</span><span>'
          + totals.unpricedCalls + '</span></div>' : '')
      + '<div class="sep"></div>'
      + '<div class="kv"><span>input tokens</span><span>' + inTok.toLocaleString() + '</span></div>'
      + '<div class="kv"><span>output tokens</span><span>' + outTok.toLocaleString() + '</span></div>'
      + (totals.reasoningTokens ? '<div class="kv"><span>of which reasoning</span><span>'
          + totals.reasoningTokens.toLocaleString() + '</span></div>' : '')
      + '<div class="kv"><span>total tokens</span><span><b>' + (inTok + outTok).toLocaleString() + '</b></span></div>';

    /* right rail: theoretical SAP BTP cost, never mixed into billed spend */
    const sapPlayers = players.filter((p) => p.cost.inputCells > 0);
    if (!sapPlayers.length) {
      els.costSap.innerHTML = '<div class="freecap">No SAP-RPT-1 player running. '
        + 'Add one to model what it would cost on real BTP — the playground itself is free.</div>';
    } else {
      const cells = totals.inputCells + totals.predictedCells;
      const piecesSap = sapPlayers.reduce((n, p) => n + (p.game ? Math.max(p.game.pieces - 1, 0) : 0), 0);
      const variants = Array.from(new Set(sapPlayers.map((p) => p.model || '—')));
      els.costSap.innerHTML =
        '<div class="big">' + eur(totals.sapEur) + '</div>'
        + '<div class="freecap" style="margin-bottom:9px;">theoretical on SAP BTP · '
        + escapeHtml(variants.join(', ')) + '</div>'
        + '<div class="sep"></div>'
        + '<div class="kv"><span>input cells</span><span>' + totals.inputCells.toLocaleString() + '</span></div>'
        + '<div class="kv"><span>predicted cells</span><span>' + totals.predictedCells.toLocaleString() + '</span></div>'
        + '<div class="kv"><span>total cells</span><span><b>' + cells.toLocaleString() + '</b></span></div>'
        + '<div class="kv"><span>capacity units</span><span>' + totals.sapCu.toFixed(5) + '</span></div>'
        + '<div class="sep"></div>'
        + (piecesSap ? '<div class="kv"><span>per piece</span><span>'
            + eur(totals.sapEur / piecesSap) + '</span></div>'
          + '<div class="kv"><span>a 1000-piece game</span><span>'
            + eur(totals.sapEur / piecesSap * 1000) + '</span></div>' : '')
        + '<div class="freecap" style="margin-top:8px;">Metered per 1,000 cells (SAP Note 3437766), '
        + 'not per token: a predicted cell costs ~100x an input cell. '
        + 'GenAI tokens x 1.90385 = capacity units; € assumes '
        + eur(global.AIConfig.eurPerCu) + '/CU, which is contract-negotiated.</div>';
    }

    /* right rail bottom: rates and a projection */
    const pieces = players.reduce((n, p) => n + (p.game ? Math.max(p.game.pieces - 1, 0) : 0), 0);
    const lines = players.reduce((n, p) => n + (p.game ? p.game.lines : 0), 0);
    const perCall = totals.billedCalls ? grand / totals.billedCalls : 0;
    els.costRates.innerHTML =
      '<div class="kv"><span>per API call</span><span>' + money(perCall) + '</span></div>'
      + '<div class="kv"><span>per piece placed</span><span>' + money(pieces ? grand / pieces : 0) + '</span></div>'
      + '<div class="kv"><span>per line cleared</span><span>' + money(lines ? grand / lines : 0) + '</span></div>'
      + '<div class="kv"><span>tokens per call</span><span>'
        + (totals.billedCalls ? Math.round((inTok + outTok) / totals.billedCalls) : 0) + '</span></div>'
      + '<div class="sep"></div>'
      + '<div class="kv"><span>next 100 pieces</span><span>' + money(pieces ? grand / pieces * 100 : 0) + '</span></div>'
      + '<div class="kv"><span>a 1000-piece game</span><span>' + money(pieces ? grand / pieces * 1000 : 0) + '</span></div>'
      + '<div class="freecap" style="margin-top:8px;">Projection assumes the current mix of players keeps playing. '
      + 'Heuristic and keyboard players are free; SAP-RPT-1 returns no token counts, so its calls are '
      + 'counted but not priced.</div>';
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function updateBanner() {
    if (!players.length) { els.banner.textContent = 'No players — add one.'; els.banner.className = 'banner'; return; }
    if (A.allFinished(players)) {
      const order = A.standings(players);
      if (players.length === 1) {
        els.banner.innerHTML = 'Game over — <b>' + order[0].game.lines + ' lines</b>, '
          + order[0].game.score.toLocaleString() + ' points, ' + order[0].game.pieces + ' pieces ('
          + (order[0].game.overReason || '') + ')';
      } else {
        els.banner.innerHTML = '🏆 <b>' + order[0].name + '</b> wins with ' + order[0].game.lines
          + ' lines · ' + order.slice(1).map((p) => p.name + ' ' + p.game.lines).join(' · ');
      }
      els.banner.className = 'banner done';
      if (!announced) {
        announced = true;
        running = false;
        els.run.textContent = 'Run';
        log('run finished — ' + A.standings(players).map((p) => p.name + ': ' + p.game.lines + ' lines').join(', '), 'good');
      }
      return;
    }
    const alive = players.filter((p) => !p.game.over).length;
    els.banner.innerHTML = 'Seed <b>' + currentSeed() + '</b> — identical piece sequence for all players · '
      + alive + ' of ' + players.length + ' alive';
    els.banner.className = 'banner';
  }

  /* ---------- loop ---------- */

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    if (running) {
      for (const player of players) A.advance(player, dt, config, paint);
    }
    for (const player of players) paint(player);
    updateBanner();
    if (now - lastCostPaint > 200) { lastCostPaint = now; paintCosts(); }
    requestAnimationFrame(frame);
  }

  /* ---------- controls ---------- */

  function currentSeed() { return parseInt(els.seed.value, 10) || 1; }

  function resetAll() {
    announced = false;
    const seed = currentSeed();
    for (const player of players) A.resetPlayer(player, seed);
    log('reset — seed ' + seed + ', ' + players.length + ' player(s)', 'dim');
    updateBanner();
  }

  els.run.addEventListener('click', () => {
    if (A.allFinished(players)) resetAll();
    running = !running;
    els.run.textContent = running ? 'Pause' : 'Run';
    log(running ? 'running' : 'paused', 'dim');
  });
  els.reset.addEventListener('click', () => { running = false; els.run.textContent = 'Run'; resetAll(); });
  els.newSeed.addEventListener('click', () => {
    els.seed.value = Math.floor(Math.random() * 100000);
    running = false; els.run.textContent = 'Run';
    resetAll();
  });
  els.seed.addEventListener('change', resetAll);
  els.speed.addEventListener('change', () => { config.speed = els.speed.value; });
  els.eurPerCu.addEventListener('change', () => {
    const v = parseFloat(els.eurPerCu.value);
    global.AIConfig.eurPerCu = Number.isFinite(v) && v > 0 ? v : 1;
    log('€/CU set to ' + global.AIConfig.eurPerCu + ' — resetting so the model re-prices', 'dim');
    resetAll();
  });
  els.candidates.addEventListener('change', () => {
    config.candidateLimit = parseInt(els.candidates.value, 10);
    global.AIConfig.candidateLimit = config.candidateLimit;
  });
  els.addPlayer.addEventListener('click', () => {
    const n = players.length + 1;
    addPlayer({ name: 'Player ' + n, pickerId: 'heuristic' });
    resetAll();
  });

  /* ---------- keyboard (drives the first human player) ---------- */

  const KEYS = {
    ArrowLeft: (g) => g.move(-1),
    ArrowRight: (g) => g.move(1),
    ArrowDown: (g) => g.softDrop(),
    ArrowUp: (g) => g.rotate(1),
    x: (g) => g.rotate(1),
    z: (g) => g.rotate(-1),
    ' ': (g) => g.hardDrop(),
    c: (g) => g.holdPiece()
  };

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.key === 'p') { els.run.click(); e.preventDefault(); return; }
    if (e.key === 'r' || e.key === 'R') { els.reset.click(); e.preventDefault(); return; }
    const me = players.find(A.isHuman);
    if (!me || !me.game || me.game.over) return;
    const fn = KEYS[e.key];
    if (fn) { fn(me.game); e.preventDefault(); }
  });

  /* ---------- boot ---------- */

  async function loadModels() {
    try {
      const res = await fetch(P.proxyUrl('/api/models'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      modelIds = (data.models || []).map((m) => m.id);
      for (const m of (data.models || [])) {
        global.ModelPrices[m.id] = { prompt: m.promptPrice || 0, completion: m.completionPrice || 0 };
      }
      els.models.innerHTML = '';
      for (const m of (data.models || [])) {
        const o = document.createElement('option');
        o.value = m.id;
        const price = m.promptPrice ? ' · $' + (m.promptPrice * 1e6).toFixed(2) + '/Mtok in' : '';
        o.label = m.name + price;
        els.models.appendChild(o);
      }
      log(modelIds.length + ' OpenRouter models available', 'dim');
      for (const p of players) syncModelField(p);
    } catch (err) {
      log('model list unavailable (' + err.message + ') — type a model id by hand', 'warn');
    }
  }

  async function loadHealth() {
    try {
      const res = await fetch(P.proxyUrl('/api/health'));
      const h = await res.json();
      const bits = [
        'openrouter ' + (h.openrouter ? '✓' : '✗'),
        'jev ' + (h.jev ? '✓ (' + h.jevVia + ')' : '✗'),
        'rpt-1 ' + (h.rpt1 ? '✓' : '✗')
      ];
      els.health.textContent = bits.join(' · ');
    } catch (err) {
      els.health.textContent = 'proxy not reachable — run node server.mjs';
    }
  }

  els.seed.value = 12345;
  addPlayer({ name: 'You', pickerId: 'human' });
  relayout();
  updateBanner();
  paintCosts();
  loadHealth();
  loadModels();
  log('ready — press Run, or add players and let them compete on the same seed', 'dim');
  requestAnimationFrame(frame);
})(window);
