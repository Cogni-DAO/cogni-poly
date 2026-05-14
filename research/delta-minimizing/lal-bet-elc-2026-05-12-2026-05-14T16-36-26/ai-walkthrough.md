# AI walkthrough · Δ-Report · Real Betis Balompié vs. Elche CF

> Audience: another agent picking up this incident. Reproduce the analysis without re-discovering the data layout.

## 1 · Input & target detection

- Input: `lal-bet-elc-2026-05-12`
- Markets resolved: 3
  - `0x70c2946c1f220e92f11ad7e2d9c9b7525625950351beeb782b6644c75bb1f999` · Will Real Betis Balompié vs. Elche CF end in a draw? · slug=`lal-bet-elc-2026-05-12-draw` · event_slug=`lal-bet-elc-2026-05-12`
  - `0xa367eee4cfc2c61db3d5dec9d64b606b2e273946bb24b6dfd71ccef6c3e84172` · Will Real Betis Balompié win on 2026-05-12? · slug=`lal-bet-elc-2026-05-12-bet` · event_slug=`lal-bet-elc-2026-05-12`
  - `0xdc576ff659520960c13030f82b4d87c25801f44f14af0aef71b87f8d019b69c5` · Will Elche CF win on 2026-05-12? · slug=`lal-bet-elc-2026-05-12-elc` · event_slug=`lal-bet-elc-2026-05-12`
- **Copy-target auto-detected**: `swisstony` (`0x204f72f35326db932158cba6adff0b9a1da95e14`, target_id `473e0467-8257-583e-ac93-dea278662cb2`, 345 decisions on these markets).
- Our wallet label in the system: `Tenant trading wallet`.

## 2 · Data sources read

| Source                            | Rows           | Notes                                                                                                                                          |
| --------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `poly_market_metadata`            | 3              | Slug → conditionId resolver. `event_title` is often null for cached rows; Gamma `/events?slug=` backfill works.                                |
| CLOB `/markets/{conditionId}`     | 6 tokens       | Authoritative `outcome` + `winner` flag. Gamma `?condition_ids=` is silently ignored.                                                          |
| `poly_trader_fills` (target + us) | 419 raw, 9 agg | Per-fill granularity used for share/VWAP series. Copy-targets only REDEEM (no SELLs) — no scalp gap.                                           |
| `poly_copy_trade_decisions`       | 345            | One row per (target fill → mirror decision). `intent` JSON carries `target_side_fraction`, `target_position_usdc`, `target_dominant_token_id`. |
| `poly_copy_trade_fills`           | 30             | Our placed orders' status transitions.                                                                                                         |

## 3 · Step-by-step computation

1. Resolve input → conditionIds via `poly_market_metadata` (event_slug, market_slug, comma-list of condition_ids, or fuzzy event_title).
2. Auto-detect copy-target: `select intent->>'target_wallet', target_id, count(*) from poly_copy_trade_decisions where market_id in (...) group by 1,2 order by count desc limit 1`.
3. Fetch authoritative labels via CLOB `/markets/{conditionId}`.
4. Pull fills for ONLY the target wallet + our wallet (RN1 and unrelated wallets excluded).
5. For each market, identify the **target's primary token** = the token they sank most BUY-cost into. Hedge = the other side.
6. Score Δ-classes against **target-mirror divergence**, not winner/loser (we copy the target's edge; whether they win or lose is their problem).

## 4 · Δ-class scoring (target-mirror framing)

| Class                    | Trigger                                                                   | Code path                                                                                       | Score formula            |
| ------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------ |
| D2 wrong-side allocation | Our $ on side OPPOSITE target's primary > 30% of our cost                 | `planMirrorFromFill` — every fill is a fresh BUY, no rotation if target reallocates             | round(hedge_cost × 10)   |
| D3 hedge blindness       | ≥1 `target_dominant_other_side` skip on what became target's primary side | `analyzeTargetDominance` + `decideMirrorBranch` (gate uses target's CURRENT dominance fraction) | primary_hits × 3 + total |
| D4 VWAP gate bouncing    | ≥1 `vwap_floor_breach` skip on target's primary side                      | `targetVwapForToken` + `NEVER_PAY_ABOVE_TARGET_VWAP` invariant                                  | primary_hits × 3 + total |
| D5 staleness / churn     | Cancellation rate > 40%                                                   | resting-sweep TTL in `order-reconciler`                                                         | canceled × 2             |

## 5 · Ranked findings for this incident

### D2 · Wrong-side allocation vs target (charter D2, score 245)

- Our wallet sank $24.48 into the OPPOSITE of swisstony's primary side (37% of our cost) — we mirrored their secondary/scalping fills as if they were directional.

### D4 · VWAP gate bouncing (charter D4, score 211)

- 133 `vwap_floor_breach` skips total; 26 were on the target's primary side — we refused to chase fills that swisstony themselves was paying.

### D3 · Hedge blindness (charter D3, score 76)

- 58 `target_dominant_other_side` skips total; 6 were actually on swisstony's final primary side (dominance flipped after the skip).

## 6 · Not checked (and why)

- **Loki for non-error skips**: `vwap_floor_breach` / `target_dominant_other_side` carry all data in `intent` JSON. Loki adds no signal except for `outcome='error'` rows.
- **Target SELL fills**: copy-targets only redeem at resolution; `poly_trader_fills` for the target is BUY + REDEEM only. No scalp gap.
- **Per-fill latency (D1)**: needs `mirror-pipeline` Loki lines. Not material once D2's structural failure has dominated.

## 7 · Confidence

High for structural Δ-classes (D2/D3/D4/D5) — scoring is deterministic from production rows. Lower for latency classes (D1/D7/D8).
