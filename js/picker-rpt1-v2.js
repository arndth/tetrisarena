/* SAP-RPT-1, second attempt: same model, better data.

   picker-rpt1.js gives RPT-1 a thin diet -- the heuristic's top-N candidates,
   48 seed rows from an almost empty board, then only the moves it already
   played. This version feeds it the way the SAP Community Tetris post does:

     every legal placement is a candidate, not a pre-filtered top-N
     context = 64 rows sampled per move from a fixed experience store
       (js/rpt1-experience.js, built by tools/build-rpt1-experience.mjs from
       self-play with 0 / 15 / 40 % random moves, so wrecked boards are in it)
     70 % of those rows come from boards of similar stack height (+-3)
     extra columns: next_piece and eroded_cells

   Two context sizes, one variant each:

     rpt1-v2      64 rows per move, like the SAP Community post
     rpt1-v2-2k   2,000 rows per move -- does more data close the gap?

   Labels are still the El-Tetris score, so the heuristic is the ceiling.
   That is deliberate: it already clears ~97 % of the physically possible
   lines, and outcome-based labels turned out too noisy to learn from (see
   tools/build-rpt1-experience.mjs). */
(function (global) {
  'use strict';

  const T = global.Tetris;
  const F = global.Features;
  const P = global.Pickers;

  const TARGET = 'placement_score';
  const PREDICT = '[PREDICT]';
  const NEAR_SHARE = 0.7;
  const NEAR_BAND = 3;

  /* Order matters: the experience store keeps rows as arrays in this order. */
  const COLUMNS = [
    'piece', 'next_piece', 'rotation', 'column',
    'lines_cleared', 'eroded_cells', 'landing_height', 'holes', 'holes_added',
    'aggregate_height', 'max_height', 'bumpiness',
    'row_transitions', 'col_transitions', 'well_sums'
  ];

  /* `grid` is the board before the placement, needed for eroded cells. */
  function featureValues(grid, p, nextType) {
    const f = p.features;
    return [
      f.piece, nextType || '', f.rotation, f.column,
      f.linesCleared, F.erodedCells(grid, p), f.landingHeight, f.holes, f.holesAdded,
      f.aggregateHeight, f.maxHeight, f.bumpiness,
      f.rowTransitions, f.colTransitions, f.wellSums
    ];
  }

  function toRow(id, values, target) {
    const row = { row_id: id };
    COLUMNS.forEach((c, i) => { row[c] = values[i]; });
    row[TARGET] = target;
    return row;
  }

  /* store row = [stackHeightBefore, elTetrisScore, ...COLUMNS] */
  function store() {
    const s = global.RPT1_EXPERIENCE;
    if (!s || !Array.isArray(s.rows) || !s.rows.length) {
      throw new Error('rpt1-v2: experience store missing -- run node tools/build-rpt1-experience.mjs');
    }
    return s.rows;
  }

  /* Each player draws its context with its own seeded RNG, so a run is
     reproducible and two RPT players do not share draws. */
  const rngs = new Map();
  function rngFor(playerId) {
    const key = playerId || 'default';
    if (!rngs.has(key)) rngs.set(key, T.mulberry32(20261026 + rngs.size));
    return rngs.get(key);
  }

  function sampleContext(rows, stackHeight, size, rand) {
    const near = rows.filter((r) => Math.abs(r[0] - stackHeight) <= NEAR_BAND);
    const nNear = Math.min(near.length, Math.round(size * NEAR_SHARE));
    const picked = [];
    const take = (pool, n) => {
      for (let i = 0; i < n; i++) picked.push(pool[Math.floor(rand() * pool.length)]);
    };
    take(near, nNear);
    take(rows, size - nNear);
    return picked.map((r, i) => toRow('ctx_' + i, r.slice(2), r[1]));
  }

  function register(id, label, size, describe) {
    P.register({
      id: id,
      label: label,
      needsProxy: true,
      needsModel: true,
      variants: function () {
        return (global.SapPricing ? global.SapPricing.RATES : []).map((r) => ({ id: r.id, label: r.label }));
      },
      defaultModel: function () { return global.SapPricing ? global.SapPricing.DEFAULT_ID : null; },
      describe: describe,
      contextSize: function () { return size; },
      pick: async function (ctx) {
        const cfg = ctx.config || {};
        const stackHeight = F.boardFeatures(ctx.grid).maxHeight;
        const context = sampleContext(store(), stackHeight, size, rngFor(ctx.playerId + ':' + id));
        const nextType = ctx.queue && ctx.queue[0];

        const byId = {};
        const queryRows = ctx.placements.map((p, i) => {
          const id = 'q_' + i;
          byId[id] = p;
          return toRow(id, featureValues(ctx.grid, p, nextType), PREDICT);
        });

        const body = global.Rpt1.requestBody(context.concat(queryRows), TARGET);
        const cellCount = global.Rpt1.countCells(body.rows);
        const data = await global.Rpt1.predict(body);

        let best = null, bestVal = -Infinity;
        for (const row of data.predictions || []) {
          const p = byId[row.row_id];
          if (!p) continue;
          const cell = row[TARGET];
          const v = Array.isArray(cell) ? (cell[0] && cell[0].prediction) : cell;
          if (typeof v === 'number' && v > bestVal) { bestVal = v; best = p; }
        }
        if (!best) throw new Error(id + ': no usable prediction for any candidate row');

        const meta = data.metadata || {};
        return {
          placement: best,
          note: 'predicted ' + bestVal.toFixed(1) + ' · ' + queryRows.length + ' candidates / '
            + context.length + ' context rows',
          confidence: null,
          fallback: false,
          usage: {
            model: 'sap-rpt-1',
            promptTokens: 0,
            completionTokens: 0,
            rows: meta.num_rows || body.rows.length,
            inputCells: cellCount.input,
            predictedCells: cellCount.predicted,
            sapVariant: cfg.model || (global.SapPricing && global.SapPricing.DEFAULT_ID),
            cost: 0,
            unpriced: true
          }
        };
      }
    });
  }

  register('rpt1-v2', 'SAP-RPT-1 v2 (all moves, 64 context rows)', 64,
    'All legal placements; 64 context rows sampled per move from a self-play store.');
  register('rpt1-v2-2k', 'SAP-RPT-1 v2 (all moves, 2,000 context rows)', 2000,
    'As rpt1-v2, with 2,000 context rows per move.');

  global.Rpt1V2 = { COLUMNS: COLUMNS, featureValues: featureValues };
})(window);
