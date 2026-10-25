/* Parallel head-to-head between move pickers: can a chat model match Jev?

   Every player gets the same seed, so they see an identical piece stream.
   Reports lines cleared, board quality (holes / stack height), how often each
   agreed with the heuristic, fallback rate, latency and real billed cost.

     node shootout.mjs                                  # default roster
     node shootout.mjs heuristic jev openai/gpt-5-nano  # pick your own
     PIECES=40 SEEDS=1,2,3 node shootout.mjs            # longer / multi-seed

   Needs `node server.mjs` running. Short runs are noisy on lines cleared --
   holes and stack height are the steadier signals. */
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.dirname(new URL(import.meta.url).pathname) + '/';
const PIECES = Number(process.env.PIECES || 25);
const SEEDS = (process.env.SEEDS || '31337').split(',').map(Number);

const win = { devicePixelRatio:1, location:{protocol:'http:'}, ModelPrices:{},
  AIConfig:{ candidateLimit:8, jevModel:'jev-latest', proxyBase:'http://localhost:8787' },
  performance:{ now:()=>Date.now() }, fetch:(...a)=>fetch(...a) };
for (const f of ['js/tetris.js','js/features.js','js/pickers.js','js/picker-jev.js','js/sap-pricing.js','js/picker-rpt1.js','js/picker-llm.js','js/arena.js'])
  new Function('window','fetch','location','performance', fs.readFileSync(ROOT+f,'utf8'))(
    win, win.fetch, win.location, win.performance);
const { Tetris:T, Features:F, Pickers:P, Arena:A } = win;
{ const d = await (await fetch('http://localhost:8787/api/models')).json();
  for (const m of d.models) win.ModelPrices[m.id] = { prompt:m.promptPrice||0, completion:m.completionPrice||0 }; }

/* Roster: "heuristic", "jev", "rpt1", or "<model-id>" for any OpenRouter chat model.
   Pass them as arguments, e.g.
     node shootout.mjs heuristic jev google/gemini-2.5-flash-lite
   Keep the roster small: several players firing at once can trip a provider's
   rate limit (one 8-player run drew 429 on 17 of 24 gemini calls). */
const ROSTER = (process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['heuristic', 'jev', 'anthropic/claude-haiku-5.5', 'google/gemini-2.5-flash-lite']
).map((spec) => (['heuristic', 'jev', 'jev-lean', 'jev-2ply', 'rpt1'].includes(spec)
  ? [spec, null] : ['llm', spec]));

async function runOne(pickerId, model, seed) {
  const player = A.createPlayer({ name: model || pickerId, pickerId, model });
  A.resetPlayer(player, seed);
  const picker = P.registry[pickerId];
  let agreed = 0, decided = 0;
  while (!player.game.over && player.game.pieces <= PIECES) {
    const g = player.game;
    const placements = F.enumeratePlacements(g.grid, g.active.type);
    if (!placements.length) { g.hardDrop(); break; }
    const baseline = P.bestByHeuristic(placements);
    const t0 = Date.now();
    let r;
    try {
      r = await picker.pick({ grid:g.grid, type:g.active.type, queue:g.queue.slice(),
        placements, baseline, playerId:player.id, config:{ model, candidateLimit:8 } });
    } catch (e) {
      player.stats.fallbacks++;
      if (!player.firstError) player.firstError = e.message;
      r = { placement: baseline.placement, note:'fallback: '+e.message, fallback:true };
    }
    player.stats.decisions++; player.stats.totalMs += Date.now()-t0;
    if (picker.needsProxy) A.recordUsage(player, r);
    decided++;
    if (r.placement.rot === baseline.placement.rot && r.placement.x === baseline.placement.x) agreed++;
    const a = g.active;
    a.rot = r.placement.rot; a.x = r.placement.x; a.y = r.placement.y;
    g.hardDrop();
  }
  const bf = F.boardFeatures(player.game.grid);
  return { name: model || pickerId, player, agreed, decided, bf, seed, err: player.firstError };
}

const all = [];
for (const seed of SEEDS) {
  process.stderr.write(`seed ${seed}…\n`);
  const res = await Promise.all(ROSTER.map(([p,m]) => runOne(p,m,seed)));
  all.push(...res);
}

/* aggregate across seeds */
const byName = new Map();
for (const r of all) {
  if (!byName.has(r.name)) byName.set(r.name, { name:r.name, lines:0, holes:0, maxh:0, agg:0,
    agreed:0, decided:0, fb:0, ms:0, calls:0, cost:0, runs:0, topped:0, pieces:0 });
  const o = byName.get(r.name);
  o.lines += r.player.game.lines; o.holes += r.bf.holes; o.maxh += r.bf.maxHeight;
  o.agg += r.bf.aggregateHeight; o.agreed += r.agreed; o.decided += r.decided;
  o.fb += r.player.stats.fallbacks; o.ms += r.player.stats.totalMs;
  o.calls += r.player.stats.decisions; o.cost += A.totalCost(r.player.cost);
  o.sapEur = (o.sapEur || 0) + (r.player.cost.sapEur || 0);
  o.cells = (o.cells || 0) + (r.player.cost.inputCells || 0) + (r.player.cost.predictedCells || 0);
  o.pieces += Math.max(r.player.game.pieces-1,0);
  o.topped += r.player.game.over ? 1 : 0; o.runs++;
  if (r.err && !o.err) o.err = r.err;
}
const rows = [...byName.values()];
const n = SEEDS.length;
console.log(`\n${PIECES} pieces × ${n} seed(s) [${SEEDS.join(',')}], 8 candidates sent per decision\n`);
console.log('model                            lines  holes  maxH  agree%  fallback%   avg ms      cost   $/line');
console.log('-'.repeat(103));
rows.sort((a,b)=> (b.lines-a.lines) || (a.holes-b.holes));
for (const o of rows) {
  const agree = o.decided ? (100*o.agreed/o.decided) : 0;
  const fbp = o.calls ? (100*o.fb/o.calls) : 0;
  const perLine = o.lines ? o.cost/o.lines : 0;
  console.log(
    o.name.padEnd(32)
    + String((o.lines/n).toFixed(1)).padStart(5)
    + String((o.holes/n).toFixed(1)).padStart(7)
    + String((o.maxh/n).toFixed(1)).padStart(6)
    + (agree.toFixed(0)+'%').padStart(8)
    + (fbp.toFixed(0)+'%').padStart(11)
    + String(o.calls? Math.round(o.ms/o.calls):0).padStart(9)
    + ('$'+o.cost.toFixed(5)).padStart(10)
    + (o.lines? '$'+perLine.toFixed(5) : '—').padStart(9)
    + (o.topped? '  TOPPED OUT '+o.topped+'/'+o.runs : ''));
  if (o.sapEur) {
    console.log('    ↳ playground free; on SAP BTP: €' + o.sapEur.toFixed(6)
      + ' (' + (o.cells/n).toLocaleString('en-US') + ' cells, €'
      + (o.sapEur / Math.max(o.pieces,1)).toFixed(6) + '/piece)');
  }
  if (o.err) console.log('    ↳ first failure: ' + o.err.slice(0,110));
}
