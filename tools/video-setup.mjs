/* Shared page setup for tools/record-video.mjs: opens the arena, configures the
   roster and applies a 1080x1080 recording layout. Needs `npm i -D playwright`
   and Google Chrome (or run `npx playwright install chromium` and drop `channel`). */
import { chromium } from 'playwright';

export const ROSTER = [
  { name: 'SAP RPT-1', backend: 'rpt1' },
  { name: 'Jev', backend: 'jev-2ply' },
  { name: 'Gemini 2.5 Flash Lite', backend: 'llm', model: 'google/gemini-2.5-flash-lite' },
  { name: 'Heuristic (no AI)', backend: 'heuristic' },
];

export const RECORD_CSS = `
  body { margin: 0 !important; padding: 28px 30px !important; box-sizing: border-box; width: 1080px; height: 1080px; overflow: hidden; }
  h1 { font-size: 34px !important; margin: 0 0 4px !important; }
  .sub, .health, .controls, #log, .keys, .panel[style*="margin-top:16px"] { display: none !important; }
  .shell { grid-template-columns: minmax(0,1fr) !important; }
  .rail { display: none !important; }
  .card select, .card .model-wrap, .card .icon { display: none !important; }
  .card .name { font-size: 18px !important; font-weight: 700 !important; pointer-events: none; }
  .arena { display: grid !important; grid-template-columns: repeat(4, minmax(0,1fr)) !important; gap: 14px !important; }
  .card canvas { width: 100% !important; height: auto !important; image-rendering: pixelated; }
`;

export async function open({ record = false } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(process.env.ARENA_URL || 'http://localhost:8787/');
  await page.waitForFunction(() => document.getElementById('modelList').children.length > 10, null, { timeout: 30000 });
  await page.evaluate(async (roster) => {
    const fire = (el, ev) => el.dispatchEvent(new Event(ev, { bubbles: true }));
    // remove the default "You" player
    document.querySelector('#arena .card .icon').click();
    for (const r of roster) {
      document.getElementById('addPlayer').click();
      const card = [...document.querySelectorAll('#arena .card')].pop();
      const name = card.querySelector('.name'); name.value = r.name; fire(name, 'input');
      const sel = card.querySelector('select'); sel.value = r.backend; fire(sel, 'change');
      if (r.model) {
        const inp = card.querySelector('input.model');
        if (inp && inp.offsetParent !== null) { inp.value = r.model; fire(inp, 'change'); }
        else { const s = card.querySelector('select.model'); s.value = r.model; fire(s, 'change'); }
      }
    }
    const sp = document.getElementById('speed'); sp.value = 'fast'; fire(sp, 'change');
    document.getElementById('reset').click();
  }, ROSTER);
  await page.addStyleTag({ content: RECORD_CSS });
  await page.evaluate(() => { document.querySelector('h1').textContent = 'Tetris Arena — same pieces for every player'; });
  return { browser, page };
}
