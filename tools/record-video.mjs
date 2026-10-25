/* Records a square (1080x1080) race video of the arena for social posts.

     node server.mjs                          # in one terminal
     node tools/record-video.mjs              # in another

   Env: PIECES (50) pieces per player, CAPTURE_MS (200) real ms per video frame
   (200 ms at 30 fps = 6x timelapse), OUT (media/tetris-arena.mp4), FFMPEG.
   Each player is frozen after PIECES pieces, so slow backends are compared on the
   same pieces rather than the same wall-clock time. Writes <OUT>.results.json. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { open, ROSTER } from './video-setup.mjs';

const N = Number(process.env.PIECES || 50);          // pieces per player
const FPS = 30;
const CAPTURE_MS = Number(process.env.CAPTURE_MS || 200);   // real ms per video frame -> speed-up = CAPTURE_MS*FPS/1000
const SPEEDUP = CAPTURE_MS * FPS / 1000;
const OUT = process.env.OUT || 'media/tetris-arena.mp4';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT],
  { stdio: ['pipe', 'inherit', 'inherit'] });
const ffDone = new Promise(r => ff.on('close', (code) => { if (code) console.error('ffmpeg exited', code); r(code); }));
const write = (buf, n = 1) => { for (let i = 0; i < n; i++) ff.stdin.write(buf); };

const { browser, page } = await open();
const card = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
const CARD_CSS = `
  body{margin:0;width:1080px;height:1080px;display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box;
    background:radial-gradient(120% 90% at 85% 0%, #1d2a4a 0%, #0b0d14 60%);color:#e9ecf5;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}
  .k{color:#8ab4ff;font-size:26px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;margin-bottom:22px}
  h1{font-size:76px;line-height:1.04;margin:0 0 28px;letter-spacing:-.02em}
  p{font-size:32px;color:#8d96ad;margin:0;line-height:1.35}
  b{color:#e9ecf5}
  table{width:100%;border-collapse:collapse;margin-top:28px;font-size:29px}
  th{color:#8d96ad;font-weight:500;text-align:right;font-size:22px;letter-spacing:.06em;text-transform:uppercase;padding:0 0 12px}
  th:first-child,td:first-child{text-align:left}
  td{padding:18px 0;border-top:1px solid rgba(255,255,255,.1);text-align:right;font-variant-numeric:tabular-nums}
  td:first-child{font-weight:700}
  .win{color:#5ad68a}
  .foot{margin-top:40px;font-size:26px;color:#8d96ad}
`;
async function cardFrame(html) {
  await card.setContent(`<html><head><style>${CARD_CSS}</style></head><body>${html}</body></html>`);
  return card.screenshot({ type: 'jpeg', quality: 92 });
}

// ---- intro ----
write(await cardFrame(`<div class="k">Tetris Arena</div>
  <h1>SAP RPT-1 vs. Jev vs. Gemini vs. a simple heuristic</h1>
  <p>Every player gets the <b>same ${N} pieces</b>.<br>Who plays best – how fast – and at what cost?</p>`), Math.round(FPS * 3.2));

// ---- race setup: freeze each player after N pieces, overlays ----
await page.evaluate(({ N, SPEEDUP }) => {
  const A = window.Arena, orig = A.advance;
  window.__done = new Set();
  window.__t0 = null;
  A.advance = function (player, ...rest) {
    const g = player.game;
    if (g && g.pieces > N && !player.plan) {
      if (!window.__done.has(player)) { window.__done.add(player); player.__doneAt = performance.now(); }
      return;
    }
    return orig.call(this, player, ...rest);
  };
  const css = document.createElement('style');
  css.textContent = `
    .rec-badge{position:fixed;top:34px;right:30px;font:600 18px/1 -apple-system,sans-serif;color:#0b0d14;background:#8ab4ff;padding:9px 14px;border-radius:999px}
    .rec-foot{margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);font-size:15px;color:#8d96ad;line-height:1.5}
    .rec-foot b{color:#e9ecf5}
    .rec-progress{height:6px;border-radius:99px;background:rgba(255,255,255,.07);margin-top:8px;overflow:hidden}
    .rec-progress i{display:block;height:100%;background:#8ab4ff}
    .card.rec-finished{outline:2px solid #5ad68a;outline-offset:-2px}
    .rec-flag{color:#5ad68a;font-weight:700}
    .banner{font-size:16px !important} .pnote{display:none !important}`;
  document.head.appendChild(css);
  const badge = document.createElement('div'); badge.className = 'rec-badge'; document.body.appendChild(badge);
  const cards = [...document.querySelectorAll('#arena .card')];
  cards.forEach(c => { const f = document.createElement('div'); f.className = 'rec-foot'; c.appendChild(f); });
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  window.__tick = () => {
    const now = performance.now(); if (window.__t0 == null) window.__t0 = now;
    badge.textContent = `⏩ ${SPEEDUP}× · real time ${fmt((now - window.__t0) / 1000)}`;
    const rows = [...document.querySelectorAll('#costPlayers .costrow')];
    cards.forEach((c, i) => {
      const stats = c.querySelector('.pstats').innerText;
      const pieces = Math.min(N, Math.max(0, (parseInt((stats.match(/(\d+)\s*pieces/) || [])[1]) || 1) - 1));
      const ms = (stats.match(/([\d.]+)\s*ms avg/) || [])[1];
      const row = rows[i];
      const cost = row ? row.querySelector('.who em').innerText : '';
      const theo = row && row.querySelector('.theo') ? row.querySelector('.theo').innerText.replace('playground free · ', '') : '';
      const finished = pieces >= N;
      c.classList.toggle('rec-finished', finished);
      c.querySelector('.rec-foot').innerHTML =
        `${finished ? '<span class="rec-flag">✓ finished</span> · ' : ''}<b>${pieces}</b>/${N} pieces` +
        `<div class="rec-progress"><i style="width:${100 * pieces / N}%"></i></div>` +
        `<div>⏱ <b>${ms ? Math.round(ms.replace('.', '')) + ' ms' : 'instant'}</b> per move</div>` +
        `<div>💶 <b>${theo ? 'free' : cost}</b>${theo ? ' <span>(~' + theo.replace(/\s*\(.*\)/, '') + ')</span>' : ''}</div>`;
    });
  };
  window.__tick();
}, { N, SPEEDUP });

// ---- race ----
await page.evaluate(() => document.getElementById('run').click());
const start = Date.now();
let frames = 0;
while (true) {
  const t = Date.now();
  await page.evaluate(() => window.__tick());
  write(await page.screenshot({ type: 'jpeg', quality: 90 }));
  frames++;
  const done = await page.evaluate((n) => window.__done.size >= n, ROSTER.length);
  if (done || Date.now() - start > 8 * 60 * 1000) break;
  const wait = CAPTURE_MS - (Date.now() - t);
  if (wait > 0) await page.waitForTimeout(wait);
}
const last = await page.screenshot({ type: 'jpeg', quality: 90 });
write(last, Math.round(FPS * 1.5));

// ---- results ----
const res = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#costPlayers .costrow')];
  return [...document.querySelectorAll('#arena .card')].map((c, i) => {
    const s = c.querySelector('.pstats').innerText;
    const row = rows[i];
    return {
      name: c.querySelector('.name').value,
      lines: parseInt((s.match(/(\d+)\s*lines/) || [])[1]) || 0,
      ms: (s.match(/([\d.]+)\s*ms avg/) || [])[1] || null,
      fallbacks: parseInt((s.match(/(\d+)\s*fallbacks/) || [])[1]) || 0,
      cost: row ? row.querySelector('.who em').innerText : '',
      theo: row && row.querySelector('.theo') ? row.querySelector('.theo').innerText : '',
    };
  });
});
fs.writeFileSync(OUT.replace(/\.[a-z0-9]+$/, '.results.json'), JSON.stringify({ N, SPEEDUP, realSeconds: (Date.now() - start) / 1000, res }, null, 2));
const best = Math.max(...res.map(r => r.lines));
write(await cardFrame(`<div class="k">Result after ${N} identical pieces</div>
  <table><tr><th>Player</th><th>Lines</th><th>Time / move</th><th>Cost</th></tr>
  ${res.map(r => `<tr><td>${r.name}</td><td class="${r.lines === best ? 'win' : ''}">${r.lines}</td>
    <td>${r.ms ? Math.round(r.ms.replace('.', '')) + ' ms' : '< 1 ms'}</td><td>${r.theo ? 'free*' : r.cost}</td></tr>`).join('')}
  </table>
  <div class="foot">${res.filter(r => r.theo).map(r => `* ${r.name} via free playground (rate-limited) – ${r.theo.replace('playground free · ', '~').replace(/\s*\(.*\)/, '')}`).join('<br>')}<br>Try it yourself – link in the post.</div>`), Math.round(FPS * 5));

ff.stdin.end();
await ffDone;
await browser.close();
console.log(JSON.stringify({ frames, realSeconds: (Date.now() - start) / 1000, out: OUT }, null, 1));
console.log(JSON.stringify(res, null, 1));
