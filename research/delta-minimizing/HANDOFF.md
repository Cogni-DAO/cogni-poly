# Δ-Minimizer + Mirror-Report — Handoff

> For the next agent picking up this work. Start by reading this end-to-end, then PR #37, then `.claude/skills/delta-minimizer/SKILL.md`.

## What this is

Two things, kept conceptually separate:

1. **`/delta-minimizer` skill** (the workflow) — `.claude/skills/delta-minimizer/SKILL.md`. The LLM's investigation discipline: one finding, code-line citations, % confidence, charter mapping, populate `findings.json`.
2. **`scripts/poly-mirror-report.ts` tool** (the data + report builder) — pulls dashboard-equivalent data for one market, renders HTML + JSON. NO analytical reasoning lives in the script; that's the skill's job.

Output dir: `research/delta-minimizing/<event_slug>-<iso>/` per investigation, tracked in git. Shared `research/delta-minimizing/charter.html` is re-rendered from `work/charters/POLY_COPY_DELTA.md` every run and includes per-D-class investigation tallies from each report's `findings.json`.

## State of PR #37

https://github.com/Cogni-DAO/cogni-poly/pull/37 · branch `derekg1729/delta-minimizer-skill-upgrade`

Commits, most recent first:

- `3ac304a8a` — variance KPI, 4-line chart, target loser override
- `986036b7f` — unblock CI (allow `research/` at repo root) + drop ai-walkthrough.md slop
- `e5000990e` — rename tool, drop classifier, net-position chart
- `d5dd934cd` — initial scaffold

CI: green. Branch is ahead by 4 commits.

## Architecture (what the script actually does)

```
input (slug | conditionId | comma-list | fuzzy)
  ↓
resolveMarkets         → poly_market_metadata prefix-match on event_slug
  ↓ anchor on our positions (OUR_POSITIONS_ANCHOR_GROUPS invariant)
detectTarget           → poly_copy_trade_decisions, wallet with most decisions on these markets
  ↓
fetchOutcomesAndLabels → CLOB /markets/<cond>, authoritative winner flag + label (Yes/No/Over/Under)
fetchOurLegs           → poly_trader_position_snapshots, loser→$0 override
fetchTargetLegs        → poly_trader_position_snapshots, loser→$0 override (same as our wallet)
fetchRawFills          → poly_trader_fills (timeline source)
fetchDecisions         → poly_copy_trade_decisions, full intent JSON
fetchPlacedOrders      → poly_copy_trade_fills (status histogram)
  ↓
buildPerWalletMetric   → snapshot-cost basis everywhere (NOT max(rollup, snapshot))
  for each (wallet, condition): {primary, hedge, net} {cost, value, pnl, vwap}
  ↓
renderHtml             → KPI cards (Our / Target / Variance), positions tables, charts, TAKEAWAY placeholder
                       → findings.json stub (LLM fills it)
                       → charter.html re-rendered with tallies
```

### Key data-source decisions

| Question                           | Choice                                                      | Why                                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where do OUR legs come from?       | `poly_trader_position_snapshots` (NOT `_current_positions`) | `_current_positions` filters `active=true` which drops loser tokens entirely. We need every leg, including losers.                                                                                                                             |
| Where do TARGET legs come from?    | Same as ours — snapshots, latest per (cond, token)          | Targets only redeem (no SELL). Append-only history survives redemption.                                                                                                                                                                        |
| What's the cost-basis denominator? | Snapshot cost basis, single source                          | Dashboard uses `max(rollup_buy, snapshot)`. We use snapshot only for **internal consistency** — earlier the dashboard's mixed-basis math produced `-35.3% (+$1610)` rows where % and $ disagreed. Trade dashboard parity for self-consistency. |
| What value override on losers?     | `outcome=loser → value 0` for BOTH our wallet and target    | Snapshot can be stale post-resolution and still show non-zero "current price" for a worthless loser. Without the override target's losing primary on Parry-Paquet kept showing $2418 value.                                                    |
| What value override on winners?    | None (use raw snapshot value)                               | Dashboard zeros redeemed winners to avoid double-counting with USDC balance. For Δ-investigation we need realized P/L visible on the position.                                                                                                 |
| What's "Variance from target"?     | `\|target_return − our_return\|` — absolute                 | The copy-trade rationale is that target has aggregate edge. **Any** divergence is a miss. The prior "alpha leak / target ahead" framing was wrong.                                                                                             |

## Chart design

Net-zero symlog $ axis. Four lines per market:

- **Solid line, upper half** = primary cost over time
- **Dashed line, lower half** = hedge cost over time
- **Green** = target wallet · **Blue** = our wallet

Plus **VWAP lines** on a secondary right axis (price $0–$1, mirrored upper/lower half). Thin, opacity 0.55, same wallet color.

Decision-marker strip below: colored dots at each decision timestamp; dimmed on hedge side.

Top-right annotation: `target: P $X @$vwap · H $Y @$vwap   ·   us: P $X @$vwap · H $Y @$vwap`.

X-axis: first activity → last activity + 5% padding. Charts share a global time scale across markets in the report.

## Files touched in PR #37

| File                                      | What it is                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/poly-mirror-report.ts`           | The tool. ~1900 LOC. Single-file by design.                                                                                              |
| `scripts/check-root-layout.ts`            | Added `"research"` to allowlist.                                                                                                         |
| `.claude/skills/delta-minimizer/SKILL.md` | Rewritten — 4-step workflow, code-mapping cheat-sheet, one-finding-rule.                                                                 |
| `research/delta-minimizing/`              | Output dir, tracked. Iteration history of this branch's runs lives here.                                                                 |
| `research/delta-minimizing/charter.html`  | Generated from `work/charters/POLY_COPY_DELTA.md` (source of truth — edit the .md).                                                      |
| `work/charters/POLY_COPY_DELTA.md`        | Charter rows D3 and D6 picked up new proof-tape evidence from WTA Parry-Paquet (added by the other agent that ran this skill mid-build). |

## Known issues / explicitly deferred

### Bugs / loose ends

- **Chart cost vs table cost**: chart shows running cumulative `BUY − SELL` from `poly_trader_fills` (so swisstony's Parry hedge displays cost $4391 in the chart annotation). The positions table shows snapshot `cost_basis_usdc` ($792). These differ when there are SELL events or when fills predate the backfill horizon. The script currently makes no attempt to reconcile. Either decision is defensible; I went with "fills = activity, snapshot = current state" but they should ideally agree.
- **VWAP lines only appear when we have positive shares on that side**. For our wallet's primary on WTA Parry-Paquet (cost $0), no primary VWAP line is drawn. That's correct but mildly confusing — a user looking for "us primary VWAP" sees nothing.
- **Findings backfill not done**: the iteration-history reports (ATP Lajovic-Altmaier, LAL BET ELC, WTA Parry-Paquet older runs) have empty `findings.json` stubs because they predated the schema. Charter tally section says "No findings yet". Author them OR delete old reports.

### Explicitly deferred (next PRs)

1. **Poly-app `/delta` nav tab** — render reports + charter as a tab in `nodes/poly/app`. Open Q's: does the `research/` dir ship in the production poly-app container? Iframe-embed or re-render server-side? Auth-gated or tenant-public?
2. **"Copy market id" button on markets dashboard rows** — UI change to the existing markets-table; copies the conditionId or event_slug to clipboard so the user can paste into `/delta-minimizer <id>`.
3. **Iterating reports → algo changes** — the WTA agent and prior ATP/LAL runs surface concrete charter rows (D3, D6). The work to actually fix `min_target_side_fraction` or the `min_mirror_position_usdc` floor is downstream; nothing here writes algorithm code.

## What to read in this order

1. **`.claude/skills/delta-minimizer/SKILL.md`** — the workflow contract end-to-end.
2. **`scripts/poly-mirror-report.ts` top-of-file docstring** — what the tool does and does NOT do.
3. **`work/charters/POLY_COPY_DELTA.md`** — the D1–D8 class taxonomy with proof tapes.
4. **`docs/spec/poly-copy-trade-execution.md`** — the mirror algorithm itself (gates, invariants, branch decision).
5. **`research/delta-minimizing/wta-parry-paquet-2026-05-13-<latest>/report.html`** — newest example report; open in browser.
6. **PR #37 diff** — review the chart-rendering and per-leg metric logic.

## What I'd code-review hard

- `buildPerWalletMetric` — the math choices (snapshot-only basis, loser override). This is where the prior agents kept making mistakes.
- `svgTimeline` — large function, lots of magic numbers. Consider extracting axis-rendering into helpers.
- The `fetchOurLegs` / `fetchTargetLegs` near-duplication. Could be a single `fetchSnapshotLegs(walletAddress, conditionIds, env)` since both apply the same outcome override now.
- The `findings.json` schema is loose — no Zod or type validation when reading it for the charter tally. A bad JSON file from a careless agent would crash the tally. Add a permissive parser.
- Many `void` statements (`void rollup;`, `void vwap;`) where I held a param/var unused after a refactor. Audit and remove if truly unused.
- ESCape-XML / escape-HTML helpers are near-duplicate. Could be one helper.

## What's likely to break next

- **Polymarket `/markets/<conditionId>` API drift** — we depend on `{tokens: [{token_id, outcome, winner}]}` shape. If they change this, label resolution breaks silently (label/winner becomes null).
- **`min_target_usdc` default of $319** — was hardcoded as `MIN_TARGET_USDC = 319` in the chart (now removed). If the prod config changes, the threshold marker stops being accurate.
- **`poly_trader_wallets.kind = 'cogni_wallet'`** — assumed to return exactly one row. If there are ever multiple, the script picks the first arbitrarily.
- **Gamma API `/events?slug=<slug>`** for backfilling `event_title` when the local cache is sparse. Same drift risk.

## Verify the build works

```bash
pnpm tsx scripts/poly-mirror-report.ts 'wta-parry-paquet-2026-05-13'
open research/delta-minimizing/wta-parry-paquet-2026-05-13-<latest>/report.html
```

Expected output: 4 chart lines visible (target primary up, target hedge down, our hedge down — primary VWAP at top, hedge VWAP at bottom). Variance KPI shows ~93.7%. Math: target return −39.8% (real loss), our +53.8% (lucky variance), |Δ| = 93.7%.

Good luck — and start by reading `SKILL.md` end-to-end, then run the tool yourself on any recent market.
