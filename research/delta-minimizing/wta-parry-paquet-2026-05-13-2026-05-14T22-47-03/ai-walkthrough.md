# AI walkthrough · Δ-Report · Paris: Diane Parry vs Chloe Paquet

> Audience: another agent picking up this incident. Reproduce the analysis without re-discovering the data layout.

## 1 · Input → resolution

- Input: `wta-parry-paquet-2026-05-13`
- Resolver: prefix-match on `event_slug` (so `<slug>` catches `<slug>-more-markets` siblings).
- Event groups returned: 1
  - **Paris: Diane Parry vs Chloe Paquet** · `wta-parry-paquet-2026-05-13` · 1 markets
    - `0x5b65ba6874edfa1e3f52493f3971bc6ecd4a372b8984d80a24ede5b1011b36a3` · Paris: Diane Parry vs Chloe Paquet
- **Copy-target**: `swisstony` (`0x204f72f35326db932158cba6adff0b9a1da95e14`, 27 decisions on these markets).
- Our wallet: `Tenant trading wallet`.

## 2 · Data sources (dashboard-equivalent)

| Source                                                                     | Notes                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `poly_trader_current_positions` (OUR wallet)                               | Cost basis + current value. Redemption-status override: winner+redeemed → value 0, loser → value 0. Mirrors `deriveCurrentPositionStatus`. |
| `poly_trader_position_snapshots` (TARGET wallet, latest per (cond, token)) | Append-only history; survives target exit. Used because targets only REDEEM, no SELL.                                                      |
| `poly_trader_fills` rollup                                                 | Per (wallet, condition): `max(BUY rollup, snapshot cost)` = canonical cost basis denominator. Matches `aggregateWalletReturn`.             |
| `poly_copy_trade_decisions` (27)                                           | Decision history with `intent` JSON.                                                                                                       |
| `poly_copy_trade_fills`                                                    | Status of OUR placed orders.                                                                                                               |
| CLOB `/markets/{cond}`                                                     | Authoritative `{token_id, outcome label, winner}` triples.                                                                                 |

## 3 · Computation, in dashboard math

- **Per (wallet, condition)** `totalBuyNotional = max(rollup_buy, snapshot_cost)`. The rollup wins when we have full fill history (our wallet); the snapshot wins when fills predate our backfill horizon (target wallet).
- **Per (wallet, condition)** `return_pct = (realized_cash + current_mark - buy_notional) / buy_notional` (Modified-Dietz).
- **Group return** = cost-basis-weighted blend of per-condition returns.
- **Δ KPI** `edgeGapPct = targetReturnPct - ourReturnPct`; `edgeGapUsdc = edgeGapPct × ourBuyNotional`. Positive Δ = target ahead = alpha leak.

## 4 · Group totals

| Group                              | Our entry | Our value | Our Δ% | Target entry | Target value | Target Δ% | edgeGap % | edgeGap $ |
| ---------------------------------- | --------- | --------- | ------ | ------------ | ------------ | --------- | --------- | --------- |
| Paris: Diane Parry vs Chloe Paquet | $7.70     | $11.84    | +53.8% | $5629        | $3640        | -35.3%    | -89.2%    | -$6.86    |

## 5 · Reason → code mapping (cheat-sheet)

| MirrorReason                  | Code                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| `below_target_percentile`     | `plan-mirror.ts:92–115`; `targetSizingUsdcForFill:657–666`            |
| `target_dominant_other_side`  | `analyzeTargetDominance` + `decideMirrorBranch`                       |
| `vwap_floor_breach`           | `targetVwapForToken` + `NEVER_PAY_ABOVE_TARGET_VWAP` invariant        |
| `followup_position_too_small` | `plan-mirror.ts:563, 572, 609, 618`                                   |
| `position_cap_reached`        | `applyMarketFloors` (cumulative intent + size > `max_usdc_per_trade`) |

Findings (charter assignment + confidence) are LLM-authored — see TAKEAWAY in `report.html` and `findings.json` for the structured form.

## 6 · Placement summary

- Filled 1 orders ($7.70) of 1 placed ($7.70 attempted)
- Canceled 0 · Errored 0

## 7 · Not checked

- **Loki**: only needed for `outcome='error'` rows where `errorCode` lives in the pino line. Skip-reason rows carry all data in the `intent` JSON.
- **Target SELL fills**: targets only redeem (no SELL). The snapshot is the truth.
- **Latency (D1)**: needs `mirror-pipeline` Loki lines. Not material once structural classes dominate.
