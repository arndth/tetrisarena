/* Any OpenRouter chat model as the player.

   Unlike Jev (typed decisions) and RPT-1 (tabular prediction), a general chat
   model has no typed-output contract we can rely on across 400+ models, so this
   backend:
     - describes the board and the legal placements as plain text,
     - asks for one option id back as JSON,
     - parses tolerantly (fenced JSON, bare JSON, or a loose option_N mention),
     - validates the answer against the legal set and falls back if it is wrong.

   No response_format / temperature is sent: reasoning models reject some of
   those parameters, and the point of this backend is that any model can play.
   Model id comes from the player's own config, so two players can run different
   models at once. */
(function (global) {
  'use strict';

  const F = global.Features;
  const P = global.Pickers;

  function describe(p, i) {
    const f = p.features;
    return 'option_' + i + ': rotate ' + f.rotation + ' quarter-turn(s), drop at column ' + f.column
      + ' -> clears ' + f.linesCleared + ' line(s), '
      + (f.holesAdded > 0 ? 'creates ' + f.holesAdded + ' new buried hole(s)' : 'creates no holes')
      + ', stack height becomes ' + f.maxHeight + ', surface roughness ' + f.bumpiness
      + ', total holes ' + f.holes;
  }

  const SYSTEM = 'You are playing Tetris. You will be given the board and a numbered list of '
    + 'legal placements for the current piece. Choose the one that keeps the stack alive longest: '
    + 'clearing lines is good, burying empty cells under filled ones is very bad, a flat low stack '
    + 'is better than a tall jagged one. Reply with JSON only, no prose, no code fence: '
    + '{"option": "option_N", "why": "<10 words max>"}';

  /* Accepts fenced JSON, bare JSON, or any loose mention of option_N. */
  function extractChoice(text, valid) {
    if (!text) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const candidates = [];
    if (fenced) candidates.push(fenced[1]);
    const braced = /\{[\s\S]*\}/.exec(text);
    if (braced) candidates.push(braced[0]);
    candidates.push(text);
    for (const raw of candidates) {
      try {
        const obj = JSON.parse(raw.trim());
        const key = obj.option || obj.choice || obj.placement;
        if (key && valid[key]) return { key: key, why: obj.why || obj.reason || '' };
      } catch (e) { /* try the next shape */ }
    }
    /* last resort: the model said "I pick option_4" in prose */
    const loose = text.match(/option[_\s-]?(\d+)/gi);
    if (loose) {
      for (let i = loose.length - 1; i >= 0; i--) {
        const key = 'option_' + loose[i].replace(/\D/g, '');
        if (valid[key]) return { key: key, why: 'parsed from prose' };
      }
    }
    return null;
  }

  P.register({
    id: 'llm',
    label: 'Any OpenRouter chat model',
    needsProxy: true,
    needsModel: true,
    describe: 'Board and candidate moves as text; the model replies with one option id.',
    pick: async function (ctx) {
      const cfg = ctx.config || {};
      const model = cfg.model;
      if (!model) throw new Error('no model selected');
      const limit = cfg.candidateLimit != null ? cfg.candidateLimit : 10;

      let cands = ctx.placements;
      if (limit > 0 && cands.length > limit) {
        cands = cands.slice().sort((a, b) => F.scorePlacement(b) - F.scorePlacement(a)).slice(0, limit);
      }
      cands = F.boardOrder(cands);
      const valid = {};
      const lines = cands.map((p, i) => { valid['option_' + i] = p; return describe(p, i); });

      const board = F.boardFeatures(ctx.grid);
      const user = 'Board (10 wide, 20 tall, "#" filled, "." empty, top row first):\n'
        + F.asciiBoard(ctx.grid)
        + '\n\nCurrent piece: ' + ctx.type
        + '\nNext pieces: ' + ctx.queue.join(', ')
        + '\nCurrent stack height: ' + board.maxHeight + ' of 20, buried holes: ' + board.holes
        + '\n\nLegal placements:\n' + lines.join('\n')
        + '\n\nWhich option do you play?';

      const res = await fetch(P.proxyUrl('/api/llm'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model,
          /* Generous: reasoning models spend output tokens thinking before they
             answer, and a 300-token cap left content empty about a third of the
             time. Only tokens actually produced are billed. */
          max_tokens: 2000,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: user }
          ]
        })
      });
      const text = await res.text();
      if (!res.ok) throw new Error(model + ' proxy ' + res.status + ': ' + text.slice(0, 160));

      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error(model + ': non-JSON reply'); }
      if (data.error) throw new Error(model + ': ' + (data.error.message || JSON.stringify(data.error)));

      const choice0 = (data.choices && data.choices[0]) || {};
      const msg = choice0.message || {};
      const content = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('') : '';
      /* Some reasoning models put everything in `reasoning` and leave content
         empty, so that text is worth scanning too before giving up. */
      const picked = extractChoice(content, valid)
        || extractChoice(typeof msg.reasoning === 'string' ? msg.reasoning : '', valid);
      if (!picked) {
        if (!content && choice0.finish_reason === 'length') {
          throw new Error(model + ': hit the output-token cap while reasoning, no answer returned');
        }
        throw new Error(model + ': could not read a legal option from "'
          + String(content || '(empty)').replace(/\s+/g, ' ').slice(0, 80) + '"');
      }

      const usage = data.usage || {};
      const bits = [picked.key + ' of ' + cands.length];
      if (picked.why) bits.push('"' + picked.why.slice(0, 40) + '"');
      if (usage.total_tokens) bits.push(usage.total_tokens + ' tok');
      return {
        placement: valid[picked.key],
        note: bits.join(' · '),
        confidence: null,
        fallback: false,
        /* OpenRouter reports real spend per call -- prefer it over any estimate */
        usage: {
          model: model,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          reasoningTokens: (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0,
          cost: typeof usage.cost === 'number' ? usage.cost : null
        }
      };
    }
  });
})(window);
