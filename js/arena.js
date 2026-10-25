/* Player list + the shared run loop.

   Every player gets its own Tetris instance seeded with the SAME seed, so the
   piece sequence is identical for all of them -- that is what makes a run a
   fair comparison rather than a luck contest. Each player owns its picker, its
   plan, its stats and its canvas. */
(function (global) {
  'use strict';

  const T = global.Tetris;
  const F = global.Features;
  const P = global.Pickers;

  const SPEEDS = { slow: 220, normal: 90, fast: 35, instant: 0 };
  let nextId = 1;

  function createPlayer(opts) {
    return {
      id: 'p' + (nextId++),
      name: opts.name || 'Player',
      pickerId: opts.pickerId || 'human',
      model: opts.model || null,
      game: null,
      plan: null,
      planAttempts: 0,
      aiTimer: 0,
      thinking: false,
      serial: 0,
      status: 'idle',
      lastNote: '',
      stats: { decisions: 0, totalMs: 0, fallbacks: 0 },
      cost: newLedger(),
      el: null
    };
  }

  /* One ledger per player. `cost` is what the provider actually billed when it
     reports it; `estimated` is what we derived from the model's price list for
     calls that came back without a cost field. `unpriced` counts calls to a
     backend that reports no usage at all (SAP AI Core). */
  function newLedger() {
    return {
      calls: 0, billedCalls: 0, failedCalls: 0, unpricedCalls: 0,
      promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
      cost: 0, estimated: 0, rows: 0,
      /* theoretical SAP BTP cost, kept strictly apart from money billed */
      inputCells: 0, predictedCells: 0, sapCu: 0, sapEur: 0
    };
  }

  /* Price table is filled from OpenRouter's own model list (see main.js). */
  function priceOf(model) {
    const table = global.ModelPrices || {};
    return table[model] || null;
  }

  function recordUsage(player, result) {
    const led = player.cost;
    led.calls++;
    if (result.fallback) { led.failedCalls++; return; }
    const u = result.usage;
    if (!u) return;
    led.promptTokens += u.promptTokens || 0;
    led.completionTokens += u.completionTokens || 0;
    led.reasoningTokens += u.reasoningTokens || 0;
    led.rows += u.rows || 0;
    if (u.inputCells || u.predictedCells) {
      led.inputCells += u.inputCells || 0;
      led.predictedCells += u.predictedCells || 0;
      /* model what the same call would cost on real BTP; the playground is free */
      if (global.SapPricing) {
        const priced = global.SapPricing.priceCells(u.inputCells || 0, u.predictedCells || 0,
          u.sapVariant, (global.AIConfig && global.AIConfig.eurPerCu));
        led.sapCu += priced.capacityUnits;
        led.sapEur += priced.eur;
      }
    }
    if (u.unpriced) { led.unpricedCalls++; return; }
    led.billedCalls++;
    if (typeof u.cost === 'number') {
      led.cost += u.cost;
      return;
    }
    const price = priceOf(u.model);
    if (price) {
      led.estimated += (u.promptTokens || 0) * (price.prompt || 0)
        + (u.completionTokens || 0) * (price.completion || 0);
    }
  }

  function totalCost(led) { return led.cost + led.estimated; }

  function sumLedgers(players) {
    const out = newLedger();
    for (const p of players) {
      for (const k of Object.keys(out)) out[k] += p.cost[k] || 0;
    }
    return out;
  }

  function isHuman(player) { return player.pickerId === 'human'; }

  function resetPlayer(player, seed) {
    player.game = T.createGame({ seed: seed });
    player.plan = null;
    player.planAttempts = 0;
    player.aiTimer = 0;
    player.thinking = false;
    player.serial++;
    player.status = 'idle';
    player.lastNote = '';
    player.stats = { decisions: 0, totalMs: 0, fallbacks: 0 };
    player.cost = newLedger();
    player.game.onSpawn = () => { player.serial++; player.plan = null; };
    player.game.onGameOver = () => {
      player.plan = null;
      player.status = 'topped out (' + (player.game.overReason || 'game over') + ')';
    };
  }

  async function requestDecision(player, config, onUpdate) {
    const game = player.game;
    const picker = P.registry[player.pickerId];
    if (!picker || !game.active || game.over) return;
    const serial = player.serial;
    const type = game.active.type;
    const placements = F.enumeratePlacements(game.grid, type);
    if (!placements.length) {
      /* Nothing legal left: drop it, which now locks out and ends the game
         instead of silently eating the piece. */
      player.status = 'no legal placement';
      game.hardDrop();
      if (onUpdate) onUpdate(player);
      return;
    }
    const baseline = P.bestByHeuristic(placements);

    player.thinking = true;
    player.status = picker.needsProxy ? 'asking ' + (player.model || picker.label) + '…'
      : 'evaluating ' + placements.length + ' placements';
    if (onUpdate) onUpdate(player);

    const t0 = performance.now();
    let result;
    try {
      result = await picker.pick({
        grid: game.grid,
        type: type,
        queue: game.queue.slice(),
        placements: placements,
        baseline: baseline,
        playerId: player.id,
        config: { model: player.model, candidateLimit: config.candidateLimit }
      });
    } catch (err) {
      player.stats.fallbacks++;
      result = { placement: baseline.placement, note: 'fallback — ' + err.message, fallback: true };
    }
    const ms = performance.now() - t0;
    player.thinking = false;

    if (serial !== player.serial || game.over) { player.status = 'discarded a stale decision'; return; }

    player.stats.decisions++;
    player.stats.totalMs += ms;
    if (picker.needsProxy) recordUsage(player, result);
    player.plan = result.placement;
    player.planAttempts = 0;
    player.aiTimer = 0;
    player.lastNote = result.note;
    player.status = result.fallback ? 'fell back to heuristic' : 'playing ' + type;
    if (onUpdate) onUpdate(player, { ms: ms, result: result, type: type });
  }

  function stepPlan(player) {
    const game = player.game;
    const a = game.active;
    if (!player.plan || !a) return;
    if (player.planAttempts++ > 40) { game.hardDrop(); player.plan = null; return; }
    if (a.rot !== player.plan.rot) {
      if (!game.rotate(1)) { game.hardDrop(); player.plan = null; }
      return;
    }
    if (a.x !== player.plan.x) {
      if (!game.move(a.x < player.plan.x ? 1 : -1)) { game.hardDrop(); player.plan = null; }
      return;
    }
    game.hardDrop();
    player.plan = null;
  }

  /* One frame for one player. Humans get gravity; AI players hard-drop every
     piece, so gravity is left out of their runs entirely. */
  function advance(player, dt, config, onUpdate) {
    const game = player.game;
    if (!game || game.over || game.paused) return;
    if (isHuman(player)) { game.tick(dt); return; }
    if (player.plan) {
      const stepMs = SPEEDS[config.speed] != null ? SPEEDS[config.speed] : 90;
      if (stepMs === 0) {
        let guard = 0;
        while (player.plan && guard++ < 60) stepPlan(player);
      } else {
        player.aiTimer += dt;
        let guard = 0;
        while (player.plan && player.aiTimer >= stepMs && guard++ < 60) {
          player.aiTimer -= stepMs;
          stepPlan(player);
        }
      }
    } else if (!player.thinking && game.active) {
      requestDecision(player, config, onUpdate);
    }
  }

  /* Ranking: lines first, then score, then pieces survived. */
  function standings(players) {
    return players.slice().sort((a, b) => {
      const ga = a.game, gb = b.game;
      if (!ga || !gb) return 0;
      return (gb.lines - ga.lines) || (gb.score - ga.score) || (gb.pieces - ga.pieces);
    });
  }

  function allFinished(players) {
    return players.length > 0 && players.every((p) => p.game && p.game.over);
  }

  global.Arena = {
    SPEEDS: SPEEDS,
    newLedger: newLedger,
    recordUsage: recordUsage,
    totalCost: totalCost,
    sumLedgers: sumLedgers,
    createPlayer: createPlayer,
    resetPlayer: resetPlayer,
    isHuman: isHuman,
    advance: advance,
    standings: standings,
    allFinished: allFinished
  };
})(window);
