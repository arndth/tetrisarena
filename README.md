# Tetris Arena

**SAP-RPT-1 vs. Jev vs. any LLM vs. a 15-line heuristic: same pieces, same
candidate moves, live cost tracking.**

[![50-piece race: SAP-RPT-1, Jev, Gemini 2.5 Flash Lite and the El-Tetris heuristic on the same seed](media/race-poster.png)](media/tetris-arena-50-pieces.mp4)

▶ [Watch the 40-second race](media/tetris-arena-50-pieces.mp4) (6× timelapse, 50 identical pieces per player)

Lately there have been plenty of demos of AI models playing Tetris. This project
asks what is actually going on behind them: how good the play is, how fast it
is, what it costs, and how much depends on the model rather than on what the
model is told. The answer turned out to be "less than you would think". A
hand-written heuristic and a well-briefed cheap model play as well as anything
else here.

---

## Contents

- [Quick start](#quick-start)
- [How the arena works](#how-the-arena-works)
- [The contestants](#the-contestants)
- [Results](#results)
- [Cost comparison](#cost-comparison)
- [How each model is asked: prompts and payloads](#how-each-model-is-asked-prompts-and-payloads)
- [How Jev was improved: the same model with three briefings](#how-jev-was-improved-the-same-model-with-three-briefings)
- [What the models were trained on](#what-the-models-were-trained-on)
- [Connecting the backends](#connecting-the-backends)
- [Project layout](#project-layout)
- [Caveats](#caveats)
- [License](#license)

---

## Quick start

Requirements: Node.js 18+ and a modern browser. There is no build step and there
are no runtime dependencies.

```sh
git clone https://github.com/arndth/tetrisarena.git
cd tetrisarena
cp .env.example .env     # add the keys for the backends you want (see below)
node server.mjs          # → http://localhost:8787
```

Open <http://localhost:8787>, press **+ Add player** a few times, pick a backend
per player and press **Run**.

- **No keys at all?** Keyboard play and the local heuristic work without any.
  You can even open `index.html` straight from disk.
- **Keys stay on the server side.** They live in `.env`, which is git-ignored.
  The browser never sees them. A small local proxy (`server.mjs`) adds them to
  outgoing calls.
- **The proxy listens on `127.0.0.1` only**, so nobody else on your network can
  spend your credits through it. Set `HOST=0.0.0.0` only if you really need to
  expose it.

---

## How the arena works

```
            same seed → identical piece stream for every player
                                   │
                    ┌──────────────┴──────────────┐
                    │   js/features.js            │
                    │   enumerate legal placements│
                    │   + board features for each │
                    └──────────────┬──────────────┘
                                   │  the SAME top-N candidates
       ┌───────────────┬───────────┼────────────┬────────────────┐
   heuristic          Jev        SAP-RPT-1   any OpenRouter     you
  (local, 0 ms)   typed choice   table       chat model      (keyboard)
                                regression    (JSON reply)
       └───────────────┴───────────┴────────────┴────────────────┘
                                   │
                    chosen placement → hard drop → next piece
```

- **Fair comparison.** Every player gets the same seed, so the piece sequence is
  identical. That makes this a comparison of decisions, not of luck.
- **The game logic is ordinary JavaScript.** Rules, collision, scoring and
  rendering are all JS. Neither Jev nor RPT-1 is a runtime or generates code;
  the models only pick a move.
- **Same candidates for everyone.** All backends choose from the same shortlist
  of legal placements: the top 10 by the heuristic score by default, adjustable
  in the UI. They also see the same board features, so nobody has an information
  advantage.
- **The game never stalls.** Errors, timeouts and illegal answers fall back to
  the heuristic's move. Each fallback is counted and shown.
- **Live cost tracking.** Two side rails show calls, tokens or cells, billed
  spend, cost per piece and per line, and a projection to 1,000 pieces.

---

## The contestants

| Backend | What it is | What it gets per piece | What comes back |
| --- | --- | --- | --- |
| **Heuristic** (`heuristic`) | El-Tetris linear scoring ([Islam El-Ashi, 2011](https://imake.ninja/el-tetris-an-improvement-on-pierre-dellacheries-algorithm/)), six weighted board features | nothing (runs locally) | best-scoring placement |
| **Jev** (`jev`, `jev-lean`, `jev-2ply`) | [TypeSafe AI](https://typesafe.ai) "System One" decision model | a `state` object + a typed `choice` question whose options are the candidates | `{choice, confidence}`; it cannot answer illegally |
| **SAP-RPT-1** (`rpt1`, `rpt1-v2`, `rpt1-v2-2k`) | [SAP's relational pretrained transformer](https://www.sap.com/products/artificial-intelligence/sap-rpt.html), a tabular foundation model | a **table**: one row per candidate, numeric feature columns, the target column marked `[PREDICT]`, plus labelled context rows | a predicted score per row, with a confidence interval and feature importances |
| **Any chat LLM** (`llm`) | any of the ~470 models on [OpenRouter](https://openrouter.ai) | the ASCII board + a numbered list of legal placements | `{"option": "option_N", "why": "…"}`, parsed tolerantly |
| **You** | keyboard | — | — |

The heuristic is the whole point of comparison. Its scoring rule is about 15 lines
(`js/features.js`):

```js
score = -4.50 * landingHeight + 3.42 * linesCleared - 3.22 * rowTransitions
        - 9.35 * colTransitions - 7.90 * holes - 3.39 * wellSums
```

Run alone, it survives more than 1,500 pieces (`node bench.mjs 3 1500`: about
599 lines, no top-out).

---

## Results

### The 50-piece race (the video)

Seed 12345, 50 identical pieces per player, 10 candidates per decision, 0
fallbacks for every player. Recorded on 2026-10-26.

| Player | Lines after 50 pieces | Time per move | Cost for 50 pieces | Per 1,000 pieces |
| --- | --- | --- | --- | --- |
| **Jev** (`jev-2ply`) | **19** | 222 ms | $0.0024 | **$0.05** |
| **Heuristic** | **19** | < 1 ms | free | **free** |
| SAP-RPT-1 (`sap-rpt-1.6`) | 18 | 3,438 ms¹ | free in playground (≈ €0.043 on BTP²) | ≈ €0.85² |
| Gemini 2.5 Flash Lite | 18 | 481 ms | $0.0039 | $0.08 |

¹ Almost entirely the free playground's mandatory request spacing (one call
every 3.5 s). The inference itself takes 0.6–1.2 s.
² Theoretical. Calculated from SAP's per-cell rate card at €1 per capacity
unit, see [cost comparison](#cost-comparison).

**How to read it.** On play quality this is a four-way tie: 18 or 19 lines is
within noise for 50 pieces. The players differ by orders of magnitude on speed
and cost instead. The heuristic matches the best model instantly and for free.

### The full field (20 pieces)

Seed 31337, 8 candidates, 0% fallbacks. Ranked by lines, then holes. Jev ran
here with its **original** prompt, before the
[prompt improvements](#how-jev-was-improved-the-same-model-with-three-briefings).

| Backend | Lines | Holes | Stack | Agreed with heuristic | Latency | Per 1,000 pieces |
| --- | --- | --- | --- | --- | --- | --- |
| `sap-rpt-1.6` | **7** | **0** | 3 | 95% | 3,371 ms | €0.68 (theoretical BTP) |
| `google/gemini-2.5-flash-lite` | **7** | **0** | **2** | 70% | 570 ms | $0.07 |
| `openai/gpt-oss-20b` | **7** | **0** | **2** | 70% | 7,861 ms | $0.09 |
| `openai/gpt-5-mini` | **7** | **0** | **2** | 70% | 5,311 ms | $0.84 |
| heuristic | 6 | 1 | 3 | 100% | **0 ms** | **free** |
| `anthropic/claude-haiku-5.5` | 6 | 1 | 4 | 50% | 3,389 ms | $0.36 |
| `jev` (original prompt) | 5 | 1 | 4 | 50% | **329 ms** | **$0.04** |
| `openai/gpt-5-nano` | 3 | 1 | 6 | 40% | 14,625 ms | $0.55 |

**Takeaways**

- **The top of the field ties on play and differs 12× in cost and 14× in
  latency.** The choice comes down to budget and speed.
  `gemini-2.5-flash-lite` is the best general-purpose pick: joint-best board,
  second-fastest and second-cheapest.
- **Bigger or "reasoning" models buy nothing here.** `gpt-5-mini` costs 12× as
  much as flash-lite for the same board. It also spent 87% of its output tokens
  on reasoning. `gpt-5-nano` is worst on every axis at once.
- **Jev is the cheapest and fastest by a wide margin.** Its typed contract never
  produced an illegal answer in any run. With the improved prompt it reaches
  heuristic-level play (see below).
- **RPT-1's 95% agreement with the heuristic is partly circular.** Its context
  rows are labelled with the heuristic's own score, so it is largely
  reproducing that function (see [what it was trained on](#what-the-models-were-trained-on)).

---

## Cost comparison

The three paid backends are billed in completely different units, which is the
main reason "which one is cheaper" is easy to get wrong.

| | Jev | Chat LLMs | SAP-RPT-1 |
| --- | --- | --- | --- |
| **Billing unit** | tokens (input; output free on OpenRouter) | input + output tokens, reasoning tokens included | **cells** (per 1,000 input cells / 1,000 predicted cells) |
| **Where the price comes from** | real `usage.cost` per call (OpenRouter) | real `usage.cost` per call (OpenRouter) | SAP rate card (SAP Note 3437766) × capacity-unit factor |
| **Typical payload per move** | ~850 input tokens | 600–1,000 input tokens + 100–2,000 output tokens | ~56 rows × 15 columns ≈ 840 cells, of which 8–10 are predicted |
| **Per 1,000 pieces (measured)** | **$0.04–0.05** | $0.07 (flash-lite) … $0.84 (gpt-5-mini) | **€0.63–0.85** on the cheapest tier, €10+ on Deep Context |
| **Free option** | — | — | the `rpt.cloud.sap` playground (rate-limited) |

**RPT-1 in detail.** SAP meters RPT-1 per 1,000 cells, not per token. A
**predicted cell costs about 103× an input cell**. That means widening the
context table is almost free, while asking for more predictions is not.

```
GenAI tokens   = inputCells/1000 × rate_in + predictedCells/1000 × rate_out
capacity units = GenAI tokens × 1.90385          (published constant)
EUR            = capacity units × your € per CU  (contract-specific; UI default 1)
```

| Model | GenAI tokens / 1k input cells | / 1k predicted cells | ≈ per 1,000 pieces |
| --- | --- | --- | --- |
| `sap-rpt-1-small`, `-1.5`, `-1.6` | 0.00020 | 0.02054 | **€0.63** |
| the same, `-large` / `tabpfn-3.5-plus` | 0.00055 | 0.07630 | €2.03 |
| `sap-rpt-1.6-large` (Deep Context) | 0.00275 | 0.38150 | €10.17 |

The game shows this live in the **SAP BTP, theoretical** panel. It is kept
strictly separate from billed spend, because the playground costs nothing.
`node sap-cost.mjs --eur-per-cu 0.9 --pieces 5000` runs the same maths on the
command line.

**In context.** At the cheapest tier, RPT-1 costs roughly 16× as much as Jev and
9× as much as flash-lite for this workload. That is the same order of magnitude,
but it is not free. Running the heuristic costs nothing at all.

---

## How each model is asked: prompts and payloads

### Chat LLMs: a system prompt plus a numbered list

```text
You are playing Tetris. You will be given the board and a numbered list of legal
placements for the current piece. Choose the one that keeps the stack alive
longest: clearing lines is good, burying empty cells under filled ones is very
bad, a flat low stack is better than a tall jagged one. Reply with JSON only, no
prose, no code fence: {"option": "option_N", "why": "<10 words max>"}
```

The user message contains the ASCII board (`#` filled, `.` empty) and one line
per candidate:

```text
option_3: rotate 1 quarter-turn(s), drop at column 4 -> clears 1 line(s),
creates no holes, stack height becomes 3, surface roughness 4, total holes 0
```

- **No model-specific parameters.** No `response_format` and no `temperature`
  are sent, so every model on OpenRouter can play.
- **Room for reasoning.** Reasoning models need output headroom: with a
  300-token cap, about 1 call in 3 came back empty, so the cap is 2,000.
- **Tolerant parsing.** The reply is accepted as fenced JSON, bare JSON, or a
  loose `option_N` in prose. It is then validated against the legal set.

### Jev: a state plus a typed question

Jev does not take a free-text prompt. It takes a `state` object and typed
`questions`. Each candidate becomes an option of a `choice` enum, so an illegal
move is impossible by construction. This is the **real request** of the best
variant (`jev-2ply`) for one position, generated from `js/picker-jev.js` (3 of
10 options shown):

```json
{
  "model": "jev-latest",
  "state": {
    "board": "..........\n..........\n........#.\n.#......##\n###....###\n######.##.",
    "board_note": "14 empty rows above this are omitted; \"#\" filled, \".\" empty, 10 columns",
    "active_piece": "L",
    "current_max_height": 4,
    "current_roughness": 9,
    "current_holes": 1,
    "rows_of_headroom": 16,
    "all_options_clear": "no lines",
    "candidate_count": 10,
    "next_piece": "Z"
  },
  "questions": {
    "placement": {
      "type": "choice",
      "instructions": "Choose where to drop the `active_piece`, thinking one piece ahead: each option also states what the best follow-up with the `next_piece` would achieve. Values are changes to the current board (see `current_*`). Decide in this order: (1) never open a new hole, and never leave the next piece unplaceable; (2) clear lines, counting the follow-up; (3) keep the stack low; (4) keep the surface flat. Only use a later rule to break a tie on the earlier ones.",
      "criteria": {
        "option_0": "rotation 0, column 3; new holes 0; height 0 (to 4); roughness +2 (to 11); then the best Z follow-up clears 0 and leaves height 5, holes 1",
        "option_1": "rotation 1, column 3; new holes 0; height 0 (to 4); roughness +4 (to 13); then the best Z follow-up clears 1 and leaves height 3, holes 1",
        "option_2": "rotation 2, column 0; new holes +1; height 0 (to 4); roughness 0 (to 9); then the best Z follow-up clears 0 and leaves height 4, holes 3",
        "…": "7 more options"
      }
    }
  }
}
```

The answer has the form `{"placement": {"choice": "option_1", "confidence": 0.81}}`.

### SAP-RPT-1: a table, not a prompt

RPT-1 gets **no text instructions at all**: no rules, no goal, not even the
word "Tetris". All it gets per move is **one table**. It sees rows whose
`placement_score` is known, and fills in the rows marked `[PREDICT]`. The arena
then plays the candidate with the highest predicted score.

This is the **real table** sent for the same position as the Jev example above.
It was generated from `js/picker-rpt1.js`. The piece is an L, 34 placements are
legal, and the board is:

```
..........
..........
........#.
.#......##
###....###
######.##.
```

| row_id | piece | rotation | column | lines_cleared | landing_height | holes | holes_added | aggregate_height | max_height | bumpiness | row_transitions | col_transitions | well_sums | placement_score |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ctx_0 | S | 0 | 0 | 0 | 1.5 | 1 | 1 | 5 | 2 | 3 | 42 | 12 | 1 | -265.37 |
| ctx_1 | S | 1 | 0 | 0 | 2 | 1 | 1 | 5 | 3 | 3 | 42 | 12 | 1 | -267.62 |
| ctx_2 | S | 0 | 3 | 0 | 1.5 | 1 | 1 | 5 | 2 | 4 | 44 | 12 | 0 | -268.42 |
| ctx_3 | S | 0 | 1 | 0 | 1.5 | 1 | 1 | 5 | 2 | 4 | 44 | 12 | 1 | -271.81 |
| … 44 more context rows … | | | | | | | | | | | | | | |
| q_0 | L | 0 | 3 | 0 | 2.5 | 1 | 0 | 23 | 4 | 11 | 48 | 12 | 5 | [PREDICT] |
| q_1 | L | 1 | 3 | 0 | 3 | 1 | 0 | 23 | 4 | 13 | 50 | 12 | 4 | [PREDICT] |
| q_2 | L | 2 | 0 | 0 | 3.5 | 2 | 1 | 24 | 4 | 9 | 44 | 14 | 2 | [PREDICT] |
| q_3 | L | 3 | 5 | 0 | 2 | 2 | 1 | 24 | 4 | 9 | 46 | 14 | 3 | [PREDICT] |
| … 6 more candidate rows … | | | | | | | | | | | | | | |

**What is in the request**

| | This arena (`js/picker-rpt1.js`) |
| --- | --- |
| **Columns** | 15: `row_id` (index) + 13 numeric/categorical features + the target `placement_score` |
| **Features** | `piece`, `rotation`, `column`, `lines_cleared`, `landing_height`, `holes`, `holes_added`, `aggregate_height`, `max_height`, `bumpiness`, `row_transitions`, `col_transitions`, `well_sums`. All describe the board **after** the move. |
| **Candidate rows (`[PREDICT]`)** | the **top 10** of the 34 legal placements, **pre-filtered by the heuristic** (UI setting "Candidates sent to models") |
| **Context rows (labelled examples)** | 48 at game start, from a short heuristic self-play (8 pieces × 6 placements, spread from best to worst). After each move, the chosen placement is added; capped at 240. |
| **Label** | the El-Tetris heuristic score of each placement, rounded to 2 decimals (`labelFor()`) |
| **Size of one request** | 58 rows × 15 columns = **870 cells**, of which 10 are predicted (at game start; grows to about 3,800 cells with 240 context rows) |
| **Task** | `regression` on `placement_score` |

```json
{
  "prediction_config": {
    "target_columns": [{ "name": "placement_score", "task_type": "regression", "prediction_placeholder": "[PREDICT]" }]
  },
  "index_column": "row_id",
  "rows": [ "48 context rows first, then the 10 [PREDICT] rows" ]
}
```

(This is the SAP AI Core format. For the free `rpt.cloud.sap` playground, the
proxy sends only `{rows, index_column}`, and the target is implied by the
`[PREDICT]` cells.)

**Three honest weaknesses of this setup**

1. **The heuristic is the teacher *and* the gatekeeper.** It labels every
   example and pre-selects the 10 candidates. RPT-1 can only re-order moves the
   heuristic already likes. That explains the 95% agreement with the heuristic,
   and why RPT-1 cannot beat it here.
2. **The context does not match the game.** The 48 starting examples come from
   an almost empty board (aggregate height ≈ 5). The positions RPT-1 is asked
   about later are much taller (≈ 23 in the example). New context rows are only
   the moves actually played, i.e. good moves. That narrows the range of labels
   RPT-1 can learn from.
3. **The next piece is not a column.** Only Jev's 2-ply variant gets to think
   one piece ahead.

### Compared with "I taught SAP RPT-1.6 to play Tetris"

The [SAP Community post](https://community.sap.com/t5/technology-blog-posts-by-sap/i-taught-sap-rpt-1-6-to-play-tetris/ba-p/14507821)
(21 Oct 2026) that inspired this project uses the same idea: one row per
placement, heuristic labels, highest prediction wins. It builds the context
much more carefully, though:

| | This arena | SAP Community post |
| --- | --- | --- |
| Model / route | `sap-rpt-1.6` via free playground (or AI Core) | `sap-rpt-1.6` on SAP AI Core |
| Candidates per move | top 10 by heuristic | **all** legal placements (9–34) |
| Columns | 15 | 18 (or 28 with the ten column heights `h0`–`h9`) |
| Extra features | — | `next_piece`, `eroded_cells`, `level`, `wells` |
| Example pool | 48 rows from 8 self-play pieces, plus the moves played | **5,000 rows** from 30 heuristic games, of which two thirds include **15% or 40% random moves** so bad positions are covered too |
| Context per request | all stored rows (48 → 240) | **64 rows sampled per move**, ~70% from positions with a similar stack height (±3 rows) |
| Request size | ~870–3,800 cells | ~1,800 cells (98 rows × 18 columns for a T piece) |
| Label | El-Tetris score | El-Tetris score (the formula itself is never sent) |
| Result | tie with Jev and the heuristic over 50 pieces | 38 / 35 lines vs. 38 / 39 for the heuristic over 2 × 100 pieces; picks the teacher's move 91% / 81% of the time; rank correlation 0.99 |
| Latency | ~3.4 s (playground rate limit) | 1.44 s median on AI Core, plus pipelining and speculative requests |
| Reported cost | ≈ €0.85 per 1,000 pieces (theoretical) | ≈ €0.09 per 100-piece game |

The post also tested Jev and two open-weight decision models zero-shot with a
short written instruction. Measured as lines cleared relative to the heuristic,
it reports **RPT-1.6 95%, GEV-26B 93%, Jev 88%**. In this arena, Jev with the
improved `jev-2ply` briefing reaches **100%** of the heuristic (see below). The
gap between Jev and RPT-1 depends heavily on what each model is given.

Both setups share the same ceiling: **RPT-1 imitates its teacher**. Whether an
outcome-based label could lift that ceiling is covered next.

### Feeding RPT-1 better data: `rpt1-v2`

`js/picker-rpt1-v2.js` fixes the three weaknesses above and follows the SAP
post's recipe:

- **All legal placements** are sent as `[PREDICT]` rows, up to 34, not a
  heuristic top 10.
- **A fixed experience store** of 11,426 rows (`js/rpt1-experience.js`) comes
  from 24 self-play games with 0, 15 or 40% random moves. Six placements per
  position are kept, spread from best to worst. Rebuild it with
  `npm run build-rpt1-experience`.
- **Context sampled per move**, 70% from positions within ±3 rows of the
  current stack height.
- **Two new columns:** `next_piece` and `eroded_cells`. That makes 17 columns.

Two variants differ only in how many context rows each request carries:

| | `rpt1-v2` | `rpt1-v2-2k` |
| --- | --- | --- |
| Context rows per move | 64 (as in the SAP post) | 2,000 (the playground maximum is 2,048; larger tables are randomly downsampled) |
| Cells per request | ~1,600 | ~35,000 |
| Prediction error on held-out store rows (MAE, score units) | 3.2 | **0.2** |

**Head-to-head.** 50 pieces × seeds 1, 2, 3, run with
`PIECES=50 SEEDS=1,2,3 node shootout.mjs heuristic jev-2ply rpt1 rpt1-v2 rpt1-v2-2k`
on 2026-10-26. The values are means per seed. "Agreed" means the player chose
the same placement as the heuristic.

| Player | Candidates it chooses from | Lines | Holes | Stack | Agreed with heuristic | On SAP BTP per 1,000 pieces |
| --- | --- | --- | --- | --- | --- | --- |
| `rpt1-v2-2k` | all (9–34) | 18.7 | 0.0 | 2.7 | **97%** | ≈ €14.0 |
| `rpt1` | top 8 by heuristic | 18.7 | 0.0 | 2.7 | 95% | ≈ €0.77 |
| heuristic | all | 18.3 | 0.0 | 2.7 | 100% | free |
| `jev-2ply` | top 8 by heuristic | 18.3 | 0.3 | 3.7 | 73% | $0.04 (billed) |
| `rpt1-v2` | all (9–34) | 18.0 | 0.0 | 4.3 | 90% | ≈ €1.46 |

All players had 0% fallbacks. The free playground allows one RPT call every
3.5 s, and three RPT players shared that limit here, so their wall-clock time
per move (~19 s) says nothing about the model.

**What this shows**

- **Lines no longer separate the players.** 50 pieces allow at most 20 lines,
  and everyone lands at 18–19.
- **The old `rpt1` looked better than it was.** Its 95% agreement comes from
  choosing among the heuristic's own top 8. `rpt1-v2` faces all 9–34
  placements and still matches the heuristic 90% of the time with 64 rows.
  That is in line with the SAP post (91% / 81%).
- **More data helps clearly.** With 2,000 rows, RPT-1 matches the heuristic on
  97% of moves from the full candidate set. It has effectively learned the
  formula from examples alone.
- **It is not worth the price here.** On BTP, 2,000 context rows cost about 18×
  as much per piece as the old setup. The formula itself is free and runs in
  under 1 ms.

**Why there are no outcome labels.** Before spending API calls, the labels were
tested offline with a ridge regression on the same 64 context rows standing in
for RPT-1. That stand-in reproduces the heuristic exactly when given heuristic
labels.

Labels based on what happened over the next few pieces failed in every form
that was tried:
- **Lines and holes over 8 pieces.** The model learned that height does not
  matter, built towers and topped out.
- **The same, normalised per position, plus a board-value term.** It still
  topped out.
- **Even a player that sees the true future topped out.** Scoring every
  placement directly by the 8-piece rollout lost too. With a 4-piece horizon
  (the 3 visible preview pieces plus one), the rollout only drew level with
  the heuristic.

Two reasons:
- **Beyond the preview, the label mostly measures luck.** Which pieces come
  next decides more than the move itself, and 64 examples cannot average that
  out.
- **The heuristic leaves almost nothing to win.** Over 200 pieces it clears
  77–79 lines, out of a physical maximum of 80 (200 pieces × 4 cells ÷ 10).

In this game, "beat the heuristic" is not a realistic goal for any model.
"Match it from examples alone" is, and `rpt1-v2-2k` does.

---

## How Jev was improved: the same model with three briefings

`js/picker-jev.js` registers three backends that call the **same model** with
the **same candidate list**. They differ only in how the situation is described:

| Variant | What changes |
| --- | --- |
| `jev` (original) | full 20-row board, absolute feature values per option, next-piece queue included but unusable, an extra "top-out risk" question |
| `jev-lean` | board **cropped** to the occupied rows; values as **deltas** from the current board; facts identical across all options **stated once** in `state` instead of repeated; an **explicit priority order**; queue dropped |
| `jev-2ply` | lean, plus **real lookahead**: for each candidate, the best follow-up with the next piece is simulated locally (< 1 ms) and reported |

The original instruction was:

> *Pick the placement that keeps this Tetris stack survivable: prefer clearing
> lines, never bury a cell under a filled one, keep the surface flat and the
> stack low.*

The lean version replaced it with a **ranked** rule set:

> *Decide in this order: (1) never open a new hole — a covered empty cell is the
> worst outcome; (2) clear lines; (3) keep the stack low; (4) keep the surface
> flat. Only use a later rule to break a tie on the earlier ones.*

**Result over 3 seeds × 40 pieces (120 decisions per variant, 0% fallbacks):**

| Variant | Lines | Buried holes | Stack height | Agreed with heuristic | Latency | Cost per line |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic (reference) | 14.3 | 0.0 | 3.7 | 100% | 0 ms | free |
| **`jev-2ply`** | **14.3** | **0.0** | **3.0** | 72% | 292 ms | **$0.00012** |
| `jev-lean` | 11.3 | 2.0 | 6.7 | 61% | 295 ms | $0.00012 |
| `jev` (original) | 9.0 | 8.3 | 9.0 | 47% | 300 ms | $0.00016 |

- **Buried holes went from 8.3 to 2.0 to 0.0.** Simply ranking "never open a
  hole" first removed three quarters of them. The lookahead removed the rest.
- **Lines went from 9.0 to 14.3 (+59%)**, matching the heuristic, with a lower
  stack than the heuristic keeps.
- **Latency is unchanged** and 2-ply is the **cheapest per line**, because it
  clears more lines per call.
- **The lesson is about information, not wording.** The original prompt spent
  81% of its board on empty rows, repeated facts that were the same for every
  option, and withheld the one thing needed to judge a move: what it leads to.
  Agreement with the heuristic rose (47% → 72%) but never reached 100%, so Jev
  plays at heuristic level through its own choices, not by imitating it.

Reproduce: `PIECES=40 SEEDS=1,2,3 node shootout.mjs heuristic jev jev-lean jev-2ply`

---

## What the models were trained on

| Model | Architecture | Training data | Trained on Tetris? |
| --- | --- | --- | --- |
| **SAP-RPT-1** | Tabular in-context learner: transformer over rows *and* columns, with column names and cell values embedded by a background language model. Introduced as **ConTextTab** ([Spinaci et al., NeurIPS 2025](https://arxiv.org/abs/2506.10707)), which builds on the TabPFN line of work. | The open research checkpoint [`SAP/sap-rpt-1-oss`](https://huggingface.co/SAP/sap-rpt-1-oss) was trained on **T4**, a subset of the **TabLib** corpus of real-world tables. Earlier table-native ICL models (TabPFN) were pretrained on synthetic tables only; ConTextTab's point is to learn from real tables, with their semantics. SAP has **not published** the training data of the hosted `sap-rpt-1.5` / `1.6` models used here. | **No.** It has never seen Tetris. Everything it knows about this task comes from the context rows in each request. |
| **Jev** | Not published. Outside observers suspect a transformer built on an open-weight LLM; TypeSafe has not confirmed this. | According to TypeSafe, trained with **RLCD (Reinforcement Learning for Calibrated Decisions)**, which optimises for confidence scores that match how often answers are right, and reportedly **entirely on synthetic data**. There is no technical paper and no independent validation yet ([overview](https://www.digitalocean.com/resources/articles/what-is-jev)). | No indication of it. |
| **Chat LLMs** | General-purpose language models. | Large-scale text and code, plus instruction tuning; reasoning models are additionally trained with RL. | No. They reason about the text description of the board. |
| **Heuristic** | Six-feature linear function. | **Not trained in this project.** The weights are the published El-Tetris values. | It *is* a Tetris algorithm. |

**Why this matters for the results.** None of the models were trained on Tetris
or fine-tuned for it. All of them are told the same features the heuristic
uses. RPT-1 is additionally shown examples labelled by the heuristic. It is
therefore not surprising that the best any of them achieves is
heuristic-level play.

---

## Connecting the backends

All keys go into `.env` (copy it from `.env.example`). `GET /api/health` shows
which routes are live.

### Jev

| Route | Key in `.env` | Endpoint | Default model |
| --- | --- | --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter.ai/api/v1/systemone` | `~typesafe/jev-latest` |
| Native | `TYPESAFE_API_KEY` | `api.typesafe.ai/v1/systemone` | `jev-latest` |

### Chat LLMs

`OPENROUTER_API_KEY` also powers every chat model. The model list is fetched
live from OpenRouter (`/api/models`) with prices, so no model id is hardcoded.

### SAP-RPT-1

RPT-1 is **not** on OpenRouter. There are three routes:

1. **`rpt.cloud.sap` playground API, free.** This is the easiest. Create a token
   in the [playground](https://rpt.cloud.sap) and set `SAP_RPT_TOKEN`. It is
   rate-limited to a burst of ~5 requests per ~15 s and 1,000 requests per
   ~50 min. The proxy therefore spaces calls 3.5 s apart
   (`SAP_RPT_MIN_INTERVAL_MS`), so you get **about one move every 3.5 s**.
2. **SAP AI Core on BTP.** Set `AICORE_AUTH_URL`, `AICORE_CLIENT_ID`,
   `AICORE_CLIENT_SECRET`, `AICORE_BASE_URL` and `RPT1_DEPLOYMENT_ID` from your
   service key. The proxy does the OAuth exchange. The extended service plan is
   required.
3. **Open weights, local.** Serve
   [`SAP/sap-rpt-1-oss`](https://huggingface.co/SAP/sap-rpt-1-oss) behind the
   same `/predict` contract and point `AICORE_BASE_URL` at it. The checkpoints
   are licensed for research use only.

> **Tip:** the playground key also works outside the game. Hand it to an AI
> coding assistant together with your own CSV and try RPT-1 on a real
> business use case.

---

## Project layout

```
index.html              markup + styling; cost rail | arena | cost rail
js/tetris.js            engine: 7-bag, rotation, collision, hold, ghost, scoring, top-out rules
js/features.js          placement enumeration + board features + El-Tetris weights (shared by ALL backends)
js/pickers.js           backend registry + heuristic
js/picker-jev.js        Jev: three prompt variants
js/picker-rpt1.js       SAP-RPT-1: table builder, context memory, prediction parsing
js/picker-rpt1-v2.js    SAP-RPT-1 v2: all candidates, context sampled from the experience store
js/rpt1-experience.js   generated experience store (11,426 labelled rows)
tools/build-rpt1-experience.mjs  regenerates js/rpt1-experience.js
js/picker-llm.js        any OpenRouter chat model
js/sap-pricing.js       RPT-1 cell rate card + capacity-unit maths
js/arena.js             players, run loop, standings, cost ledger
js/render.js            canvas drawing
js/main.js              UI wiring, cost rails, keyboard
server.mjs              static server + key-holding proxy: /api/{models,llm,jev,rpt1,health}
bench.mjs               headless heuristic benchmark (no network)
shootout.mjs            headless head-to-head: lines, holes, latency, real cost
sap-cost.mjs            CLI: RPT-1 cost per piece / per game for every variant
media/                  race video + poster
```

Controls: `←` `→` move · `↑`/`x`/`z` rotate · `↓` soft drop · `space` hard
drop · `c` hold · `p` run/pause · `r` reset.

---

## Caveats

- **Small samples.** The headline runs are 20–50 pieces on one seed, and the
  prompt study is 120 decisions per variant. Lines cleared is the noisiest
  metric at that length; holes and stack height are steadier. For a firmer
  ranking run `PIECES=60 SEEDS=1,2,3 node shootout.mjs heuristic jev-2ply rpt1 google/gemini-2.5-flash-lite`.
- **Only the heuristic is proven over a long game** (more than 1,500 pieces).
  None of the models has been shown to survive that long.
- **RPT-1 is measured through the free playground.** Its latency reflects the
  playground's rate limit, not the model, and its euro costs are theoretical.
- **Prices and models change.** All numbers are from October 2026 and come from
  OpenRouter's billed `cost` field or SAP's published rate card.
- **Not affiliated with SAP, TypeSafe AI, OpenRouter, Google or any other
  provider.** All product names belong to their owners.

---

## License

[MIT](LICENSE). Backends call third-party APIs under their own terms. The
SAP-RPT-1 open-weights checkpoint is licensed for research use only.
