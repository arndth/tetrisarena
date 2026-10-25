/* Move-picker registry. A picker receives the enumerated legal placements and
   returns the one to play:

     pick(ctx) -> Promise<{ placement, note, confidence, fallback }>
     ctx = { grid, type, queue, placements, baseline }

   `baseline` is the heuristic's choice, used as the fallback whenever a model
   backend is unreachable or answers with something illegal. */
(function (global) {
  'use strict';

  const F = global.Features;
  const registry = {};

  function register(picker) { registry[picker.id] = picker; }

  function bestByHeuristic(placements) {
    let best = null, bestScore = -Infinity;
    for (const p of placements) {
      const s = F.scorePlacement(p);
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return { placement: best, score: bestScore };
  }

  register({
    id: 'heuristic',
    label: 'Heuristic (El-Tetris weights)',
    needsProxy: false,
    describe: 'Local, no network. Fixed linear weights over six board features.',
    pick: async function (ctx) {
      const b = bestByHeuristic(ctx.placements);
      return {
        placement: b.placement,
        note: 'score ' + b.score.toFixed(1) + ' of ' + ctx.placements.length + ' candidates',
        confidence: null,
        fallback: false
      };
    }
  });

  /* file:// pages have no same-origin proxy, so point them at the local server. */
  function proxyUrl(path) {
    const base = (global.AIConfig && global.AIConfig.proxyBase) ||
      (location.protocol === 'file:' ? 'http://localhost:8787' : '');
    return base + path;
  }

  global.Pickers = {
    registry: registry,
    proxyUrl: proxyUrl,
    register: register,
    bestByHeuristic: bestByHeuristic,
    list: function () { return Object.keys(registry).map((k) => registry[k]); }
  };
})(window);
