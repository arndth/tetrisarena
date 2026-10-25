/* Headless self-play for the local heuristic -- no browser, no network.
   Loads the same engine and feature code the page uses.

     node bench.mjs [games] [maxPieces] */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const win = {};
for (const f of ['js/tetris.js', 'js/features.js']) {
  new Function('window', fs.readFileSync(path.join(ROOT, f), 'utf8'))(win);
}
const { Tetris: T, Features: F } = win;

const games = Number(process.argv[2] || 3);
const maxPieces = Number(process.argv[3] || 1500);

function play(seed) {
  const game = T.createGame({ seed });
  while (!game.over && game.pieces <= maxPieces) {
    const a = game.active;
    const placements = F.enumeratePlacements(game.grid, a.type);
    if (!placements.length) break;
    let best = null, bestScore = -Infinity;
    for (const p of placements) {
      const s = F.scorePlacement(p);
      if (s > bestScore) { bestScore = s; best = p; }
    }
    a.rot = best.rot; a.x = best.x; a.y = best.y;
    game.hardDrop();
  }
  return { score: game.score, lines: game.lines, pieces: game.pieces, over: game.over };
}

const results = [];
for (let i = 0; i < games; i++) {
  const t0 = Date.now();
  const r = play(1000 + i);
  results.push(r);
  console.log('game ' + (i + 1) + ': ' + r.lines + ' lines, ' + r.score.toLocaleString()
    + ' points, ' + r.pieces + ' pieces, ' + (r.over ? 'topped out' : 'piece cap')
    + ' (' + (Date.now() - t0) + 'ms)');
}
const avg = (k) => (results.reduce((s, r) => s + r[k], 0) / results.length).toFixed(0);
console.log('---');
console.log('avg lines ' + avg('lines') + ', avg score ' + avg('score') + ', avg pieces ' + avg('pieces'));
