/* SAP-RPT-1 backend -- relational pretrained transformer, tabular in-context
   learning. It predicts cell values, so the Tetris move choice is reshaped into
   a regression over a table:

     one row per candidate placement, columns = board features
     target column "placement_score", marked "[PREDICT]" on the rows we ask about
     context rows = placements already seen this session, with their known score

   RPT-1 fills in the blanks, we play the highest-scoring row. No training job,
   no fine-tuning -- the context rows are the supervision, which is the whole
   point of the model.

   NOTE on labels: the context rows are labelled with the El-Tetris baseline
   score, so RPT-1 is generalising that scoring function from examples rather
   than discovering a better one. Swap `labelFor` for an outcome-based label
   (e.g. lines cleared over the following 10 pieces) if you want it to learn
   something the baseline does not already know.

   Requests go through server.mjs, which does the SAP AI Core OAuth dance and
   forwards to /v2/inference/deployments/<id>/predict . */
(function (global) {
  'use strict';

  const T = global.Tetris;
  const F = global.Features;
  const P = global.Pickers;

  const TARGET = 'placement_score';
  const PREDICT = '[PREDICT]';
  const MAX_CONTEXT = 240;

  /* One context table per player, so two RPT-1 players in a tournament learn
     from their own board history instead of a shared one. */
  const tables = new Map();
  let rowSeq = 0;

  function tableFor(playerId) {
    const key = playerId || 'default';
    if (!tables.has(key)) tables.set(key, seeded());
    return tables.get(key);
  }

  function labelFor(p) { return Math.round(F.scorePlacement(p) * 100) / 100; }

  function featureRow(p, id) {
    const f = p.features;
    return {
      row_id: id,
      piece: f.piece,
      rotation: f.rotation,
      column: f.column,
      lines_cleared: f.linesCleared,
      landing_height: f.landingHeight,
      holes: f.holes,
      holes_added: f.holesAdded,
      aggregate_height: f.aggregateHeight,
      max_height: f.maxHeight,
      bumpiness: f.bumpiness,
      row_transitions: f.rowTransitions,
      col_transitions: f.colTransitions,
      well_sums: f.wellSums
    };
  }

  function remember(context, p) {
    const row = featureRow(p, 'ctx_' + (rowSeq++));
    row[TARGET] = labelFor(p);
    context.push(row);
    while (context.length > MAX_CONTEXT) context.shift();
  }

  /* RPT-1 needs context rows on the very first call, so prime the table with a
     short heuristic self-play run before the game starts. */
  function seedContext(context, pieces, perPiece) {
    const rand = T.mulberry32(20261021);
    let grid = T.emptyGrid(T.ROWS, T.COLS);
    for (let i = 0; i < pieces; i++) {
      const type = T.TYPES[Math.floor(rand() * T.TYPES.length)];
      const cands = F.enumeratePlacements(grid, type);
      if (!cands.length) break;
      const sorted = cands.slice().sort((a, b) => F.scorePlacement(b) - F.scorePlacement(a));
      /* keep good and bad examples so the target column has real spread */
      const picks = [];
      for (let k = 0; k < perPiece && k < sorted.length; k++) {
        picks.push(sorted[Math.floor((k / perPiece) * sorted.length)]);
      }
      picks.forEach((x) => remember(context, x));
      grid = sorted[0].nextGrid;
    }
    return context;
  }

  function seeded() { return seedContext([], 8, 6); }

  function requestBody(rows, target) {
    return {
      prediction_config: {
        target_columns: [
          { name: target || TARGET, task_type: 'regression', prediction_placeholder: PREDICT }
        ]
      },
      index_column: 'row_id',
      /* context rows must precede the prediction rows */
      rows: rows
    };
  }

  function countCells(rows) {
    const cellCount = { input: 0, predicted: 0 };
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (row[key] === PREDICT) cellCount.predicted++;
        else cellCount.input++;
      }
    }
    return cellCount;
  }

  async function predict(body) {
    const res = await fetch(P.proxyUrl('/api/rpt1'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error('rpt1 proxy ' + res.status + ': ' + text.slice(0, 200));
    try { return JSON.parse(text); } catch (e) { throw new Error('rpt1: non-JSON reply'); }
  }

  /* Shared with picker-rpt1-v2.js, which builds a different table but talks
     to the same endpoint. */
  global.Rpt1 = { requestBody: requestBody, countCells: countCells, predict: predict };

  P.register({
    id: 'rpt1',
    label: 'SAP-RPT-1 (tabular placement scorer)',
    needsProxy: true,
    needsModel: true,
    /* the SAP rate card prices these very differently, so let the player pick */
    variants: function () {
      return (global.SapPricing ? global.SapPricing.RATES : []).map((r) => ({ id: r.id, label: r.label }));
    },
    defaultModel: function () { return global.SapPricing ? global.SapPricing.DEFAULT_ID : null; },
    describe: 'Candidate placements as table rows; RPT-1 regresses the [PREDICT] score column.',
    contextSize: function (playerId) { return tableFor(playerId).length; },
    pick: async function (ctx) {
      const cfg = ctx.config || {};
      const context = tableFor(ctx.playerId);
      const limit = cfg.candidateLimit != null ? cfg.candidateLimit
        : ((global.AIConfig && global.AIConfig.candidateLimit) || 0);
      let cands = ctx.placements;
      if (limit > 0 && cands.length > limit) {
        cands = cands.slice().sort((a, b) => F.scorePlacement(b) - F.scorePlacement(a)).slice(0, limit);
      }

      const byId = {};
      const queryRows = cands.map((p, i) => {
        const id = 'q_' + i;
        byId[id] = p;
        const row = featureRow(p, id);
        row[TARGET] = PREDICT;
        return row;
      });

      const body = requestBody(context.concat(queryRows));
      const cellCount = countCells(body.rows);
      const data = await predict(body);
      const preds = data.predictions || [];
      let best = null, bestVal = -Infinity, bestIdx = -1, bestCI = null;
      preds.forEach((row, i) => {
        const p = byId[row.row_id];
        if (!p) return;
        const cell = row[TARGET];
        const first = Array.isArray(cell) ? cell[0] : null;
        const v = first ? first.prediction : cell;
        if (typeof v === 'number' && v > bestVal) {
          bestVal = v; best = p; bestIdx = i;
          bestCI = first && Array.isArray(first.confidence_interval) ? first.confidence_interval : null;
        }
      });
      if (!best) throw new Error('rpt1: no usable prediction for any candidate row');

      /* The cloud route also returns per-row feature importances; show which
         column it leaned on most for the row it actually chose. */
      let topFeature = null;
      const scores = data.explanations && data.explanations.top_column_scores;
      if (Array.isArray(scores) && bestIdx >= 0 && scores[bestIdx]) {
        const entries = Object.keys(scores[bestIdx]).map((k) => [k, scores[bestIdx][k]]);
        entries.sort((a, b) => b[1] - a[1]);
        if (entries.length) topFeature = entries[0][0] + ' ' + entries[0][1];
      }

      remember(context, best);
      const meta = data.metadata || {};
      const bits = ['predicted ' + bestVal.toFixed(1)];
      if (bestCI) bits.push('ci [' + bestCI[0].toFixed(0) + ', ' + bestCI[1].toFixed(0) + ']');
      if (topFeature) bits.push('leaned on ' + topFeature);
      bits.push(queryRows.length + ' query / ' + context.length + ' context rows');
      if (typeof data.delay === 'number' && data.delay > 2000) {
        bits.push('server delay ' + Math.round(data.delay / 1000) + 's');
      }
      if (data.samplingMetadata && data.samplingMetadata.downsampled) bits.push('context downsampled');
      return {
        placement: best,
        note: bits.join(' · '),
        confidence: null,
        fallback: false,
        /* SAP AI Core bills by deployment capacity and returns no token counts,
           so cost is genuinely unknown here rather than zero. */
        usage: {
          model: 'sap-rpt-1',
          promptTokens: 0,
          completionTokens: 0,
          rows: meta.num_rows || body.rows.length,
          /* RPT-1 is metered per 1,000 cells, so cells are what we count.
             Input cells are every submitted cell that is not a [PREDICT]. */
          inputCells: cellCount.input,
          predictedCells: cellCount.predicted,
          sapVariant: cfg.model || (global.SapPricing && global.SapPricing.DEFAULT_ID),
          /* the playground bills nothing; BTP cost is modelled separately */
          cost: 0,
          unpriced: true
        }
      };
    }
  });
})(window);
