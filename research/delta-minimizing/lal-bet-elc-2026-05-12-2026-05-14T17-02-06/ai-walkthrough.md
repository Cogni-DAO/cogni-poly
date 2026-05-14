# AI walkthrough · Δ-Report · Real Betis Balompié vs. Elche CF

> Audience: another agent picking up this incident. Reproduce the analysis without re-discovering the data layout.

## 1 · Input → resolution

- Input: `lal-bet-elc-2026-05-12`
- Resolver: prefix-match on `event_slug` (so `<slug>` catches `<slug>-more-markets` siblings).
- Event groups returned: 2
  - **Real Betis Balompié vs. Elche CF** · `lal-bet-elc-2026-05-12` · 3 markets
    - `0x70c2946c1f220e92f11ad7e2d9c9b7525625950351beeb782b6644c75bb1f999` · Will Real Betis Balompié vs. Elche CF end in a draw?
    - `0xa367eee4cfc2c61db3d5dec9d64b606b2e273946bb24b6dfd71ccef6c3e84172` · Will Real Betis Balompié win on 2026-05-12?
    - `0xdc576ff659520960c13030f82b4d87c25801f44f14af0aef71b87f8d019b69c5` · Will Elche CF win on 2026-05-12?
  - **Real Betis Balompié vs. Elche CF - More Markets** · `lal-bet-elc-2026-05-12-more-markets` · 3 markets
    - `0xb9745c525d588f86f910750cc960e0b386ab1b26da004ed1f920e2058518c5d5` · Real Betis Balompié vs. Elche CF: O/U 4.5
    - `0xc697ff200d6cb8b8d25b27598d4b0ee1d29a69409308fe48d32fe27071dd419a` · Real Betis Balompié vs. Elche CF: O/U 1.5
    - `0x3075299d77c1bc3622478d38be1d45421749466091a5a0f20537879657bfe010` · Real Betis Balompié vs. Elche CF: O/U 2.5
- **Copy-target**: `swisstony` (`0x204f72f35326db932158cba6adff0b9a1da95e14`, 477 decisions on these markets).
- Our wallet: `Tenant trading wallet`.

## 2 · Data sources (dashboard-equivalent)

| Source                                                                     | Notes                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `poly_trader_current_positions` (OUR wallet)                               | Cost basis + current value. Redemption-status override: winner+redeemed → value 0, loser → value 0. Mirrors `deriveCurrentPositionStatus`. |
| `poly_trader_position_snapshots` (TARGET wallet, latest per (cond, token)) | Append-only history; survives target exit. Used because targets only REDEEM, no SELL.                                                      |
| `poly_trader_fills` rollup                                                 | Per (wallet, condition): `max(BUY rollup, snapshot cost)` = canonical cost basis denominator. Matches `aggregateWalletReturn`.             |
| `poly_copy_trade_decisions` (477)                                          | Decision history with `intent` JSON.                                                                                                       |
| `poly_copy_trade_fills`                                                    | Status of OUR placed orders.                                                                                                               |
| CLOB `/markets/{cond}`                                                     | Authoritative `{token_id, outcome label, winner}` triples.                                                                                 |

## 3 · Computation, in dashboard math

- **Per (wallet, condition)** `totalBuyNotional = max(rollup_buy, snapshot_cost)`. The rollup wins when we have full fill history (our wallet); the snapshot wins when fills predate our backfill horizon (target wallet).
- **Per (wallet, condition)** `return_pct = (realized_cash + current_mark - buy_notional) / buy_notional` (Modified-Dietz).
- **Group return** = cost-basis-weighted blend of per-condition returns.
- **Δ KPI** `edgeGapPct = targetReturnPct - ourReturnPct`; `edgeGapUsdc = edgeGapPct × ourBuyNotional`. Positive Δ = target ahead = alpha leak.

## 4 · Group totals

| Group                                           | Our entry | Our value | Our Δ%  | Target entry | Target value | Target Δ% | edgeGap % | edgeGap $ |
| ----------------------------------------------- | --------- | --------- | ------- | ------------ | ------------ | --------- | --------- | --------- |
| Real Betis Balompié vs. Elche CF                | $65.35    | $0.00     | -100.0% | $87712       | $50131       | -42.8%    | +57.2%    | +$37.35   |
| Real Betis Balompié vs. Elche CF - More Markets | $20.99    | $0.50     | -97.6%  | $24543       | $17504       | -28.7%    | +68.9%    | +$14.47   |

## 5 · Δ-class scoring (target-mirror framing)

| Class                    | Trigger                                                                   | Code path                |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------ |
| D2 wrong-side allocation | Our cost on OPPOSITE side from target's primary > 30% of our cost         | `planMirrorFromFill`     |
| D3 hedge blindness       | ≥1 `target_dominant_other_side` skip on what became target's primary side | `analyzeTargetDominance` |
| D4 VWAP gate bouncing    | ≥1 `vwap_floor_breach` skip on target's primary side                      | `targetVwapForToken`     |
| D5 staleness             | Cancel rate > 40%                                                         | resting-sweep TTL        |

## 6 · Ranked findings

### D2 · Wrong-side allocation vs target (charter D2, score 331)

- Our wallet sank $33.11 into the side OPPOSITE swisstony's primary (38% of our cost).

### D4 · VWAP gate bouncing (charter D4, score 241)

- 163 `vwap_floor_breach` skips total; 26 were on swisstony's primary side.

### D3 · Hedge blindness (charter D3, score 145)

- 112 `target_dominant_other_side` skips; 11 on swisstony's final primary side.

### D5 · Order staleness / churn (charter D5, score 52)

- 26 of 48 placements canceled (54%).

## 7 · Placement summary

- Filled 16 orders ($82.56) of 48 placed ($364.61 attempted)
- Canceled 26 · Errored 6

## 8 · Not checked

- **Loki**: only needed for `outcome='error'` rows where `errorCode` lives in the pino line. Skip-reason rows carry all data in the `intent` JSON.
- **Target SELL fills**: targets only redeem (no SELL). The snapshot is the truth.
- **Latency (D1)**: needs `mirror-pipeline` Loki lines. Not material once structural classes dominate.
