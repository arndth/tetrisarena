/* SAP-RPT-1 cost model — the real rate card, from SAP Note 3437766.

   The crucial detail: RPT-1 is metered per 1,000 CELLS, not per 1,000 tokens
   ("Token für generative KI (pro 1000 Zellen)"). Input cells and predicted
   cells are priced separately, and a predicted cell costs ~100x an input cell.

   Chain (SAP AI Core service guide, "Metering and Pricing for Generative AI"):
     GenAI tokens  = (inputCells/1000 x rate_in) + (predictedCells/1000 x rate_out)
     capacity units = GenAI tokens x 1.90385
     EUR           ~ capacity units x <your CU price>

   The CU constant is published; the EUR per CU is contract-negotiated, so it is
   a knob (default 1, i.e. the widely cited "1 BTP credit ~ EUR 1" list figure).

   Everything this produces is THEORETICAL: the rpt.cloud.sap playground this
   game actually calls is free and unmetered. It answers "what would this cost
   on real BTP", and is kept apart from money actually billed. */
(function (global) {
  'use strict';

  const CU_PER_GENAI_TOKEN = 1.90385;

  /* GenAI tokens per 1,000 cells */
  const RATES = [
    { id: 'sap-rpt-1.6',            label: 'SAP-RPT-1.6 / 1.5 / 1-small',        inputCells: 0.00020, predictedCells: 0.02054 },
    { id: 'sap-rpt-1.6-large',      label: 'SAP-RPT-1.6 / 1.5 / 1 — large',      inputCells: 0.00055, predictedCells: 0.07630 },
    { id: 'sap-rpt-1.6-large-deep', label: 'SAP-RPT-1.6-large (Deep Context)',   inputCells: 0.00275, predictedCells: 0.38150 },
    { id: 'tabpfn-3.5-plus',        label: 'tabpfn-3.5-plus (<100k rows)',       inputCells: 0.00055, predictedCells: 0.07630 },
    { id: 'tabpfn-3.5-plus-1m',     label: 'tabpfn-3.5-plus (100k–1M rows)',     inputCells: 0.00076, predictedCells: 0.11400 }
  ];

  const byId = {};
  for (const r of RATES) byId[r.id] = r;

  const DEFAULT_ID = 'sap-rpt-1.6';

  function rateFor(id) { return byId[id] || byId[DEFAULT_ID]; }

  /* cells -> GenAI tokens -> capacity units -> EUR */
  function priceCells(inputCells, predictedCells, id, eurPerCu) {
    const rate = rateFor(id);
    const genaiTokens = (inputCells / 1000) * rate.inputCells
      + (predictedCells / 1000) * rate.predictedCells;
    const cu = genaiTokens * CU_PER_GENAI_TOKEN;
    return {
      model: rate.id,
      label: rate.label,
      inputCells: inputCells,
      predictedCells: predictedCells,
      genaiTokens: genaiTokens,
      capacityUnits: cu,
      eur: cu * (eurPerCu == null ? 1 : eurPerCu)
    };
  }

  global.SapPricing = {
    CU_PER_GENAI_TOKEN: CU_PER_GENAI_TOKEN,
    RATES: RATES,
    DEFAULT_ID: DEFAULT_ID,
    rateFor: rateFor,
    priceCells: priceCells
  };
})(window);
