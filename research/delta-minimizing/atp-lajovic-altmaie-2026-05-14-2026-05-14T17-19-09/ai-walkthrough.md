# AI walkthrough · Δ-Report · Valencia: Dusan Lajovic vs Daniel Altmaier

> Audience: another agent picking up this incident. Reproduce the analysis without re-discovering the data layout.

## 1 · Input → resolution

- Input: `atp-lajovic-altmaie-2026-05-14`
- Resolver: prefix-match on `event_slug` (so `<slug>` catches `<slug>-more-markets` siblings).
- Event groups returned: 1
  - **Valencia: Dusan Lajovic vs Daniel Altmaier** · `atp-lajovic-altmaie-2026-05-14` · 1 markets
    - `0xdc545f79f6315197d79db0a5c6f83d04354c46aa8fb1dd11e6f8db3c20ec96c6` · Valencia: Dusan Lajovic vs Daniel Altmaier
- **Copy-target**: `swisstony` (`0x204f72f35326db932158cba6adff0b9a1da95e14`, 66 decisions on these markets).
- Our wallet: `Tenant trading wallet`.

## 2 · Data sources (dashboard-equivalent)

| Source                                                                     | Notes                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `poly_trader_current_positions` (OUR wallet)                               | Cost basis + current value. Redemption-status override: winner+redeemed → value 0, loser → value 0. Mirrors `deriveCurrentPositionStatus`. |
| `poly_trader_position_snapshots` (TARGET wallet, latest per (cond, token)) | Append-only history; survives target exit. Used because targets only REDEEM, no SELL.                                                      |
| `poly_trader_fills` rollup                                                 | Per (wallet, condition): `max(BUY rollup, snapshot cost)` = canonical cost basis denominator. Matches `aggregateWalletReturn`.             |
| `poly_copy_trade_decisions` (66)                                           | Decision history with `intent` JSON.                                                                                                       |
| `poly_copy_trade_fills`                                                    | Status of OUR placed orders.                                                                                                               |
| CLOB `/markets/{cond}`                                                     | Authoritative `{token_id, outcome label, winner}` triples.                                                                                 |

## 3 · Computation, in dashboard math

- **Per (wallet, condition)** `totalBuyNotional = max(rollup_buy, snapshot_cost)`. The rollup wins when we have full fill history (our wallet); the snapshot wins when fills predate our backfill horizon (target wallet).
- **Per (wallet, condition)** `return_pct = (realized_cash + current_mark - buy_notional) / buy_notional` (Modified-Dietz).
- **Group return** = cost-basis-weighted blend of per-condition returns.
- **Δ KPI** `edgeGapPct = targetReturnPct - ourReturnPct`; `edgeGapUsdc = edgeGapPct × ourBuyNotional`. Positive Δ = target ahead = alpha leak.

## 4 · Group totals

| Group                                      | Our entry | Our value | Our Δ% | Target entry | Target value | Target Δ% | edgeGap % | edgeGap $ |
| ------------------------------------------ | --------- | --------- | ------ | ------------ | ------------ | --------- | --------- | --------- |
| Valencia: Dusan Lajovic vs Daniel Altmaier | $4.57     | $5.52     | +20.7% | $8243        | $4605        | -44.1%    | -64.9%    | -$2.97    |

## 5 · Δ-class scoring (target-mirror framing)

| Class                    | Trigger                                                                   | Code path                |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------ |
| D2 wrong-side allocation | Our cost on OPPOSITE side from target's primary > 30% of our cost         | `planMirrorFromFill`     |
| D3 hedge blindness       | ≥1 `target_dominant_other_side` skip on what became target's primary side | `analyzeTargetDominance` |
| D4 VWAP gate bouncing    | ≥1 `vwap_floor_breach` skip on target's primary side                      | `targetVwapForToken`     |
| D5 staleness             | Cancel rate > 40%                                                         | resting-sweep TTL        |

## 6 · Ranked findings

### D4 · VWAP gate bouncing (charter D4, score 62)

- 26 `vwap_floor_breach` skips total; 12 were on swisstony's primary side.

## 7 · Placement summary

- Filled 2 orders ($4.57) of 2 placed ($4.57 attempted)
- Canceled 0 · Errored 0

## 8 · Not checked

- **Loki**: only needed for `outcome='error'` rows where `errorCode` lives in the pino line. Skip-reason rows carry all data in the `intent` JSON.
- **Target SELL fills**: targets only redeem (no SELL). The snapshot is the truth.
- **Latency (D1)**: needs `mirror-pipeline` Loki lines. Not material once structural classes dominate.
