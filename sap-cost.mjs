/* What the RPT-1 player would cost on real SAP BTP.

   SAP-RPT-1 is metered per 1,000 CELLS, not per 1,000 tokens
   ("Token für generative KI (pro 1000 Zellen)", SAP Note 3437766), and input
   cells and predicted cells are priced separately — a predicted cell costs
   about 103x an input cell.

   Chain (SAP AI Core service guide, "Metering and Pricing for Generative AI"):
     GenAI tokens   = (inputCells/1000 x rate_in) + (predictedCells/1000 x rate_out)
     capacity units = GenAI tokens x 1.90385
     EUR            = capacity units x <your negotiated CU price>

   Usage:
     node sap-cost.mjs                        # measured workload, all variants
     node sap-cost.mjs --candidates 34        # send every legal placement
     node sap-cost.mjs --context 240 --eur-per-cu 0.9
*/
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const win = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'js/sap-pricing.js'), 'utf8'))(win);
const S = win.SapPricing;

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : d;
};

const COLUMNS   = arg('columns', 15);      /* row_id + 14 feature columns */
const context   = arg('context', 48);      /* rolling context rows */
const candidates = arg('candidates', 8);   /* query rows = candidate placements */
const pieces    = arg('pieces', 1000);
const eurPerCu  = arg('eur-per-cu', 1);

const rows = context + candidates;
const totalCells = rows * COLUMNS;
const predicted = candidates;              /* one [PREDICT] target per query row */
const input = totalCells - predicted;

const eur = (v) => (v < 0.01 ? '€' + v.toFixed(6) : v < 1 ? '€' + v.toFixed(4) : '€' + v.toFixed(2));

console.log('');
console.log('one decision (one Tetris piece)');
console.log(`  table              ${rows} rows x ${COLUMNS} cols = ${totalCells} cells`);
console.log(`  input cells        ${input}`);
console.log(`  predicted cells    ${predicted}`);
console.log(`  CU constant        ${S.CU_PER_GENAI_TOKEN}   ·   EUR per CU ${eurPerCu}`);
console.log('');
console.log('variant                          GenAI tok        CU   per piece   per ' + pieces + ' pieces');
console.log('-'.repeat(84));
for (const r of S.RATES) {
  const p = S.priceCells(input, predicted, r.id, eurPerCu);
  console.log(
    r.id.padEnd(30)
    + p.genaiTokens.toExponential(3).padStart(11)
    + p.capacityUnits.toFixed(6).padStart(11)
    + eur(p.eur).padStart(12)
    + eur(p.eur * pieces).padStart(18));
}
console.log('');
console.log('for scale, measured on OpenRouter in this project (per ' + pieces + ' pieces)');
console.log('  jev                          $' + (0.0000359 * pieces).toFixed(2));
console.log('  google/gemini-2.5-flash-lite $' + (0.000069 * pieces).toFixed(2));
console.log('  openai/gpt-5-mini            $' + (0.000985 * pieces).toFixed(2));
console.log('');
console.log('Rates are the published GenAI-token-per-1000-cells factors. The EUR per');
console.log('capacity unit is contract-negotiated and defaults to 1 here (the commonly');
console.log('cited "1 BTP credit ~ EUR 1" list figure) — override with --eur-per-cu.');
console.log('The generative AI hub also requires the extended service plan.');
