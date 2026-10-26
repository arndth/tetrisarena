/* Jev backends — TypeSafe AI "System One".

   Jev is not a code runtime and not an agent: it takes one state plus a set of
   typed questions and returns typed probabilistic answers, then stops. That maps
   onto Tetris as exactly one call per piece: the candidate placements become a
   `choice` enum, so an illegal answer is impossible by construction.

   Three prompt variants are registered so they can compete head-to-head. They
   share the identical candidate list (same pre-sort, same cap) and differ ONLY
   in what is described to the model:

     jev        control — the original prompt: full 20-row board, absolute
                feature values per option, next-piece queue included but unused,
                plus a display-only top-out-risk question.
     jev-lean   same information, less noise: board cropped to the occupied
                region, values given as DELTAS from the current board, fields
                that are identical across every option hoisted into `state`
                instead of repeated per option, an explicit priority order for
                the cases where "clear lines" and "stay flat" conflict, and the
                unusable next-piece queue dropped.
     jev-2ply   lean, plus real lookahead: for every candidate we locally
                simulate the best follow-up with the NEXT piece and report what
                it leads to. This makes the next piece actionable rather than
                decoration.

   Requests go through server.mjs, which holds the key and routes to either
   api.typesafe.ai/v1/systemone or openrouter.ai/api/v1/systemone. */
(function (global) {
  'use strict';

  const T = global.Tetris;
  const F = global.Features;
  const P = global.Pickers;

  /* A capped enum keeps the baseline's top moves; identical for every variant
     so the comparison is fair. They are then listed in board order, so the
     option number does not give away the baseline's favourite. */
  function shortlist(placements, limit) {
    const sorted = placements.slice().sort((a, b) => F.scorePlacement(b) - F.scorePlacement(a));
    return F.boardOrder(limit > 0 ? sorted.slice(0, limit) : sorted);
  }

  function signed(n) { return (n > 0 ? '+' : '') + n; }

  /* ---------- board rendering ---------- */

  function fullBoard(grid) { return F.asciiBoard(grid); }

  /* Crop to the occupied region plus a little headroom: 81% of the rows in a
     full render are empty and carry no information. */
  function croppedBoard(grid) {
    let top = grid.findIndex((row) => row.some((c) => c));
    if (top < 0) return { text: '(empty board)', hidden: grid.length };
    const from = Math.max(0, top - 2);
    const text = grid.slice(from).map((row) => row.map((c) => (c ? '#' : '.')).join('')).join('\n');
    return { text: text, hidden: from };
  }

  /* ---------- per-option descriptions ---------- */

  function describeAbsolute(p) {
    const f = p.features;
    return [
      'rotation ' + f.rotation + ', column ' + f.column,
      f.linesCleared ? 'clears ' + f.linesCleared + ' line' + (f.linesCleared > 1 ? 's' : '') : 'clears nothing',
      f.holesAdded > 0 ? 'opens ' + f.holesAdded + ' new hole' + (f.holesAdded > 1 ? 's' : '') : 'opens no holes',
      'resulting max height ' + f.maxHeight,
      'surface roughness ' + f.bumpiness,
      'total holes ' + f.holes
    ].join('; ');
  }

  /* Deltas against the current board, with fields that are constant across the
     whole candidate list left out (they are stated once in `state` instead). */
  function describeDelta(p, base, varying) {
    const f = p.features;
    const bits = ['rotation ' + f.rotation + ', column ' + f.column];
    if (varying.linesCleared) bits.push('clears ' + f.linesCleared);
    if (varying.holesAdded) bits.push('new holes ' + signed(f.holesAdded));
    if (varying.maxHeight) bits.push('height ' + signed(f.maxHeight - base.maxHeight) + ' (to ' + f.maxHeight + ')');
    if (varying.bumpiness) bits.push('roughness ' + signed(f.bumpiness - base.bumpiness) + ' (to ' + f.bumpiness + ')');
    return bits.join('; ');
  }

  /* ---------- 2-ply lookahead ---------- */

  /* Best achievable follow-up for `nextType` on the board this candidate leaves. */
  function lookahead(p, nextType) {
    if (!nextType) return null;
    const follow = F.enumeratePlacements(p.nextGrid, nextType);
    if (!follow.length) return { dead: true };
    let best = follow[0], bestScore = F.scorePlacement(follow[0]);
    for (const q of follow) {
      const s = F.scorePlacement(q);
      if (s > bestScore) { bestScore = s; best = q; }
    }
    return {
      dead: false,
      options: follow.length,
      cleared: best.features.linesCleared,
      maxHeight: best.features.maxHeight,
      holes: best.features.holes
    };
  }

  /* ---------- request builders ---------- */

  function buildControl(ctx, cands) {
    const criteria = {};
    cands.forEach((p, i) => { criteria['option_' + i] = describeAbsolute(p); });
    const board = F.boardFeatures(ctx.grid);
    return {
      criteria: criteria,
      state: {
        board: fullBoard(ctx.grid),
        active_piece: ctx.type,
        next_pieces: ctx.queue.join(', '),
        stack_max_height: board.maxHeight,
        stack_holes: board.holes,
        rows_remaining: ctx.grid.length - board.maxHeight,
        candidate_count: cands.length
      },
      questions: {
        placement: {
          type: 'choice',
          instructions: 'Pick the placement that keeps this Tetris stack survivable: '
            + 'prefer clearing lines, never bury a cell under a filled one, keep the surface flat and the stack low. '
            + 'The board in `board` is 10 wide and 20 tall, "#" is filled, "." is empty, the top row is row 0.',
          criteria: criteria
        },
        topout_risk: {
          type: 'noul',
          instructions: 'Is this stack in danger of topping out within the next few pieces? See `board` and `stack_max_height`.'
        }
      }
    };
  }

  function leanCommon(ctx, cands) {
    const base = F.boardFeatures(ctx.grid);
    const crop = croppedBoard(ctx.grid);
    /* which fields actually differ across the candidate list? */
    const varying = {};
    for (const k of ['linesCleared', 'holesAdded', 'maxHeight', 'bumpiness']) {
      varying[k] = new Set(cands.map((p) => p.features[k])).size > 1;
    }
    const state = {
      board: crop.text,
      board_note: crop.hidden + ' empty rows above this are omitted; "#" filled, "." empty, 10 columns',
      active_piece: ctx.type,
      current_max_height: base.maxHeight,
      current_roughness: base.bumpiness,
      current_holes: base.holes,
      rows_of_headroom: ctx.grid.length - base.maxHeight
    };
    /* state the facts that are the same for every option, once */
    if (!varying.linesCleared) {
      const n = cands[0].features.linesCleared;
      state.all_options_clear = n ? n + ' line(s)' : 'no lines';
    }
    if (!varying.holesAdded) {
      const n = cands[0].features.holesAdded;
      state.all_options_open_new_holes = n ? String(n) : 'none';
    }
    return { base: base, varying: varying, state: state };
  }

  function buildLean(ctx, cands) {
    const c = leanCommon(ctx, cands);
    const criteria = {};
    cands.forEach((p, i) => { criteria['option_' + i] = describeDelta(p, c.base, c.varying); });
    c.state.candidate_count = cands.length;
    return {
      criteria: criteria,
      state: c.state,
      questions: {
        placement: {
          type: 'choice',
          instructions: 'Choose where to drop the `active_piece`. Values are changes to the current board '
            + '(see `current_*`). Decide in this order: (1) never open a new hole — a covered empty cell is '
            + 'the worst outcome; (2) clear lines; (3) keep the stack low; (4) keep the surface flat '
            + '(lower roughness). Only use a later rule to break a tie on the earlier ones.',
          criteria: criteria
        }
      }
    };
  }

  function buildTwoPly(ctx, cands) {
    const c = leanCommon(ctx, cands);
    const nextType = ctx.queue && ctx.queue[0];
    const criteria = {};
    cands.forEach((p, i) => {
      let text = describeDelta(p, c.base, c.varying);
      const la = lookahead(p, nextType);
      if (la && la.dead) text += '; then the ' + nextType + ' cannot be placed at all';
      else if (la) {
        text += '; then the best ' + nextType + ' follow-up clears ' + la.cleared
          + ' and leaves height ' + la.maxHeight + ', holes ' + la.holes;
      }
      criteria['option_' + i] = text;
    });
    c.state.candidate_count = cands.length;
    c.state.next_piece = nextType || 'unknown';
    return {
      criteria: criteria,
      state: c.state,
      questions: {
        placement: {
          type: 'choice',
          instructions: 'Choose where to drop the `active_piece`, thinking one piece ahead: each option also '
            + 'states what the best follow-up with the `next_piece` would achieve. Values are changes to the '
            + 'current board (see `current_*`). Decide in this order: (1) never open a new hole, and never '
            + 'leave the next piece unplaceable; (2) clear lines, counting the follow-up; (3) keep the stack '
            + 'low; (4) keep the surface flat. Only use a later rule to break a tie on the earlier ones.',
          criteria: criteria
        }
      }
    };
  }

  /* ---------- shared call path ---------- */

  function makePicker(id, label, describeLabel, build) {
    return {
      id: id,
      label: label,
      needsProxy: true,
      describe: describeLabel,
      pick: async function (ctx) {
        const cfg = ctx.config || {};
        const limit = cfg.candidateLimit != null ? cfg.candidateLimit
          : ((global.AIConfig && global.AIConfig.candidateLimit) || 0);
        const cands = shortlist(ctx.placements, limit);
        const byId = {};
        cands.forEach((p, i) => { byId['option_' + i] = p; });

        const built = build(ctx, cands);
        const body = {
          /* the proxy rewrites this to the right id for whichever route is live */
          model: cfg.model || (global.AIConfig && global.AIConfig.jevModel) || 'jev-latest',
          state: built.state,
          questions: built.questions
        };

        const res = await fetch(P.proxyUrl('/api/jev'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        const text = await res.text();
        if (!res.ok) throw new Error('jev proxy ' + res.status + ': ' + text.slice(0, 200));

        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error('jev: non-JSON reply'); }
        if (data.error) {
          throw new Error('jev: ' + (data.error.message || JSON.stringify(data.error)));
        }
        /* native API wraps answers in `answers`; the OpenRouter decisions route
           may return them at the top level — accept either */
        const answers = data.answers || data;
        const ans = answers.placement || null;
        const chosen = ans && byId[ans.choice];
        if (!chosen) {
          throw new Error('jev: answer "' + (ans && ans.choice) + '" is not a legal candidate');
        }

        const risk = answers.topout_risk && answers.topout_risk.noul;
        const bits = [ans.choice + ' of ' + cands.length];
        if (typeof ans.confidence === 'number') bits.push('confidence ' + ans.confidence.toFixed(2));
        if (typeof risk === 'number') bits.push('top-out risk ' + risk.toFixed(2));
        if (data.model) bits.push(data.model);

        const usage = data.usage || {};
        return {
          placement: chosen,
          note: bits.join(' · '),
          confidence: typeof ans.confidence === 'number' ? ans.confidence : null,
          fallback: false,
          promptBytes: JSON.stringify(body).length,
          usage: {
            model: data.model || 'jev',
            /* the systemone route names these input_/output_ rather than prompt_/completion_ */
            promptTokens: usage.input_tokens || 0,
            completionTokens: usage.output_tokens || 0,
            cost: typeof usage.cost === 'number' ? usage.cost : null
          }
        };
      }
    };
  }

  P.register(makePicker('jev', 'Jev — original prompt',
    'Full board, absolute values, queue included, plus a risk read.', buildControl));
  P.register(makePicker('jev-lean', 'Jev — lean prompt',
    'Cropped board, deltas, constants hoisted, explicit priority order.', buildLean));
  P.register(makePicker('jev-2ply', 'Jev — lean + lookahead',
    'Lean, plus the best follow-up with the next piece per option.', buildTwoPly));
})(window);
