---
name: paper-trade-diff-analysis
description: "Compare a preview paper-trading twin tenant against a PROD live tenant to validate that the paper algorithm matches the real one. Use when the user says 'paper twin diff', 'is paper tracking live', 'trust-twin', 'paper-trade-diff', 'twin pnl', 'paper fidelity', or asks how to rapidly A/B copy-trade configs without burning real USDC. v0 hard constraint: the only acceptable trust signal is paper-twin vs PROD on the same target wallet + same config."
---

# Paper-Trade Diff Analysis

## Goal

**Paper trading must produce the same decisions as live trading on the same algorithm, so we can A/B copy-trade configs without burning real USDC.** Every divergence between the trust-twin (preview, `mode=paper`) and PROD live on the same target wallet is either (a) a paper-fidelity bug worth fixing, or (b) a known irreducible ceiling worth documenting. The diff is the only honest signal — synthetic confidence is not.

**v0 trust contract**: a trust-twin tenant on preview running Derek's exact PROD config (`swisstony, P80, $15`) must track PROD daily PnL within ±5% over a rolling 7d window before any experimental config gets promoted.

## Required reading BEFORE you analyze

- [`work/projects/proj.poly-paper-trading.md`](../../../work/projects/proj.poly-paper-trading.md) — project charter, Phase 1 trust-twin plan, fidelity ceiling (~96-98% under limit-only + ride-to-redemption), v0 deferrals.
- [`docs/spec/poly-copy-trade-execution.md`](../../../docs/spec/poly-copy-trade-execution.md) — the live algorithm. `MODE_DISCRIMINATOR_IN_ATTRIBUTES`, `PAPER_DISPATCH_IS_ENV_ONLY`, `CAP_COUNTS_REALIZED_ON_CANCEL`, the cancel-policy triggers (TTL=2min, target-SELL, stale-resting). Paper inherits all of these unchanged.
- [`.context/handoff-paper-trading-review.md`](../../../.context/handoff-paper-trading-review.md) — fidelity gap catalog from prior owner: queue position not modeled, `filled_size_usdc` v0 hardcode, sidecar SQLite ephemeral.
- [`.context/handoff-paper-trading-next.md`](../../../.context/handoff-paper-trading-next.md) — current state + carryover risks: PVC missing, Data-API ~5min lag, realized $-PnL JOIN deferred.
- [`nodes/poly/scripts/paper-twin-diff.ts`](../../../nodes/poly/scripts/paper-twin-diff.ts) — the actual diff tool. CLI for twin vs PROD per-market join + summary.
- [`nodes/poly/app/src/app/api/v1/poly/research/copy-trade-pnl/route.ts`](../../../nodes/poly/app/src/app/api/v1/poly/research/copy-trade-pnl/route.ts) + service — the SQL-aggregated tenant rollup the script reads.

## Workflow (4 steps)

1. **Set the time window.** Use `PAPER_TWIN_DIFF_SINCE=<twin-registration-time-ISO>` so the comparison excludes PROD history the twin never had a chance to mirror. Without this, the diff is structurally pessimistic and the number is meaningless. (Twin registered 2026-05-17T20:32Z for current swisstony config; check `.env.cogni` for the canonical value.)
2. **Run the diff.** The script reads `POLY_PREVIEW_TRUST_TWIN_*` and `POLY_PROD_TENANT_*` from `.env.cogni`. Output is a per-market table (sorted by |Δ realized $|) + a summary with `both_open / twin_only / live_only / both_closed` buckets and total intent + realized exposure deltas.
3. **Bucket each material divergence by category.** Four expected buckets, in priority order:
   - **paper-fidelity bug** — twin under-fills due to Data-API lag, ephemeral SQLite reset, or partial-fill `filled_size_usdc` drift. Fix in the sidecar / overlay; track each as a `task.*` or `bug.*`.
   - **structural ceiling** — queue position not modeled. The OSS engine inherently overstates fills when our limit price is at the target's queue-leader level. Document, do not "fix" — it's the irreducible 2-4%.
   - **algorithm divergence** — same algo, different decisions on the same inputs. This is the bug class the diff exists to surface. Pick one market → run [`/delta-minimizer`](../delta-minimizer/SKILL.md) on it for a per-market root-cause investigation.
   - **state mismatch** — PROD had a position pre-T0 that the twin didn't; follow-up branches (`layer`, `hedge`, `sell_close`) fire only in PROD. Expected for the first 2-4 weeks; converges as pre-T0 markets resolve.
4. **Persist the scorecard.** Write to `docs/research/<date>-paper-twin-diff.md` per the [`data-research`](../data-research/SKILL.md) persistence convention. Frontmatter `type: scorecard`, `domain: paper_twin`, `confidence_pct: 40` (draft). Cite the diff JSON inline. Link any spike work items filed for the divergences.

## Sibling skills

- [`/delta-minimizer`](../delta-minimizer/SKILL.md) — once this skill finds a single market with a material algorithm-divergence Δ, that's the per-market root-cause loop.
- [`/poly-copy-trading`](../poly-copy-trading/SKILL.md) — for changes to the mirror algorithm itself (planner, coordinator, ledger).
- [`/data-research`](../data-research/SKILL.md) — for new aggregation views over `poly_copy_trade_fills` / `poly_trader_*` tables (SQL-aggregation invariant, scorecard persistence).
