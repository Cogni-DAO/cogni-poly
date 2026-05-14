# AI walkthrough · Δ-Report · Real Betis Balompié vs. Elche CF

> Audience: another agent picking up this incident. Reproduce the analysis without re-discovering the data layout.

## 1 · Input → resolution

- Input: `lal-bet-elc-2026-05-12`
- Resolver: prefix-match on `event_slug` (so `<slug>` catches `<slug>-more-markets` siblings).
- Event groups returned: 3
  - **Real Betis Balompié vs. Elche CF** · `lal-bet-elc-2026-05-12` · 3 markets
    - `0x70c2946c1f220e92f11ad7e2d9c9b7525625950351beeb782b6644c75bb1f999` · Will Real Betis Balompié vs. Elche CF end in a draw?
    - `0xa367eee4cfc2c61db3d5dec9d64b606b2e273946bb24b6dfd71ccef6c3e84172` · Will Real Betis Balompié win on 2026-05-12?
    - `0xdc576ff659520960c13030f82b4d87c25801f44f14af0aef71b87f8d019b69c5` · Will Elche CF win on 2026-05-12?
  - **Real Betis Balompié vs. Elche CF - More Markets** · `lal-bet-elc-2026-05-12-more-markets` · 9 markets
    - `0x4028fce186270ffe0ecf2d82d34443a6efff67510eabd5662901c9bf401539e2` · Real Betis Balompié vs. Elche CF: O/U 3.5
    - `0x80fd03a17cde814d494f7699f7cc539658d425b5555862b263ba923bf0cb5f7b` · Spread: Real Betis Balompié (-1.5)
    - `0xb9745c525d588f86f910750cc960e0b386ab1b26da004ed1f920e2058518c5d5` · Real Betis Balompié vs. Elche CF: O/U 4.5
    - `0xc697ff200d6cb8b8d25b27598d4b0ee1d29a69409308fe48d32fe27071dd419a` · Real Betis Balompié vs. Elche CF: O/U 1.5
    - `0x4da6d1f274ef9e9f6eaef1fc47862538f830c0b855c21674af35d391ebc405bc` · Spread: Elche CF (-2.5)
    - `0x3075299d77c1bc3622478d38be1d45421749466091a5a0f20537879657bfe010` · Real Betis Balompié vs. Elche CF: O/U 2.5
    - `0x94ddcf870661d16113572b5f68572e4975ece5be05a7bcef12abbc1b2961c263` · Spread: Elche CF (-1.5)
    - `0x300e99cda5949d01f9f45a7f46ef30bf72353c30be38af2a3a4c0f347f6700c4` · Spread: Real Betis Balompié (-2.5)
    - `0x1e7dc2b29a52b789675f56c13374567e036e3bf177aadc721a070d61e00fcf31` · Real Betis Balompié vs. Elche CF: Both Teams to Score
  - **Real Betis Balompié vs. Elche CF - Halftime Result** · `lal-bet-elc-2026-05-12-halftime-result` · 3 markets
    - `0x611f2f27cbce5b7dea8a906e89e44f2db7bfd10eca0cd52fe5cb0868dd3b33b0` · Elche CF leading at halftime?
    - `0xa795075e7700f1f7e8127e474347282cf153bfede6418f7f61d42d01bcf6fad3` · Real Betis Balompié leading at halftime?
    - `0x56e6b6a5f166db3c6a7ada01850347c23f5ff4e43d4a96dd1aa8e7571588a337` · Real Betis Balompié vs. Elche CF: Draw at halftime?
- **Copy-target**: `swisstony` (`0x204f72f35326db932158cba6adff0b9a1da95e14`, 704 decisions on these markets).
- Our wallet: `Tenant trading wallet`.

## 2 · Data sources (dashboard-equivalent)

| Source                                                                     | Notes                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `poly_trader_current_positions` (OUR wallet)                               | Cost basis + current value. Redemption-status override: winner+redeemed → value 0, loser → value 0. Mirrors `deriveCurrentPositionStatus`. |
| `poly_trader_position_snapshots` (TARGET wallet, latest per (cond, token)) | Append-only history; survives target exit. Used because targets only REDEEM, no SELL.                                                      |
| `poly_trader_fills` rollup                                                 | Per (wallet, condition): `max(BUY rollup, snapshot cost)` = canonical cost basis denominator. Matches `aggregateWalletReturn`.             |
| `poly_copy_trade_decisions` (704)                                          | Decision history with `intent` JSON.                                                                                                       |
| `poly_copy_trade_fills`                                                    | Status of OUR placed orders.                                                                                                               |
| CLOB `/markets/{cond}`                                                     | Authoritative `{token_id, outcome label, winner}` triples.                                                                                 |

## 3 · Computation, in dashboard math

- **Per (wallet, condition)** `totalBuyNotional = max(rollup_buy, snapshot_cost)`. The rollup wins when we have full fill history (our wallet); the snapshot wins when fills predate our backfill horizon (target wallet).
- **Per (wallet, condition)** `return_pct = (realized_cash + current_mark - buy_notional) / buy_notional` (Modified-Dietz).
- **Group return** = cost-basis-weighted blend of per-condition returns.
- **Δ KPI** `edgeGapPct = targetReturnPct - ourReturnPct`; `edgeGapUsdc = edgeGapPct × ourBuyNotional`. Positive Δ = target ahead = alpha leak.

## 4 · Group totals

| Group                                              | Our entry | Our value | Our Δ%  | Target entry | Target value | Target Δ% | edgeGap % | edgeGap $ |
| -------------------------------------------------- | --------- | --------- | ------- | ------------ | ------------ | --------- | --------- | --------- |
| Real Betis Balompié vs. Elche CF                   | $65.35    | $0.00     | -100.0% | $87712       | $50131       | -42.8%    | +57.2%    | +$37.35   |
| Real Betis Balompié vs. Elche CF - More Markets    | $20.99    | $0.50     | -97.6%  | $73450       | $52566       | -28.4%    | +69.2%    | +$14.52   |
| Real Betis Balompié vs. Elche CF - Halftime Result | $0.00     | $0.00     | —       | $419.42      | $671.84      | +60.2%    | —         | —         |

## 5 · Δ-class scoring (target-mirror framing)

| Class                    | Trigger                                                                   | Code path                |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------ |
| D2 wrong-side allocation | Our cost on OPPOSITE side from target's primary > 30% of our cost         | `planMirrorFromFill`     |
| D3 hedge blindness       | ≥1 `target_dominant_other_side` skip on what became target's primary side | `analyzeTargetDominance` |
| D4 VWAP gate bouncing    | ≥1 `vwap_floor_breach` skip on target's primary side                      | `targetVwapForToken`     |
| D5 staleness             | Cancel rate > 40%                                                         | resting-sweep TTL        |

## 6 · Ranked findings

### D4 · VWAP gate bouncing (charter D4, score 334)

- 256 `vwap_floor_breach` skips total; 26 were on swisstony's primary side.

### D2 · Wrong-side allocation vs target (charter D2, score 331)

- Our wallet sank $33.11 into the side OPPOSITE swisstony's primary (38% of our cost).

### D3 · Hedge blindness (charter D3, score 196)

- 163 `target_dominant_other_side` skips; 11 on swisstony's final primary side.

### D5 · Order staleness / churn (charter D5, score 76)

- 38 of 76 placements canceled (50%).

## 7 · Placement summary

- Filled 16 orders ($82.56) of 76 placed ($941.49 attempted)
- Canceled 38 · Errored 22

## 8 · Not checked

- **Loki**: only needed for `outcome='error'` rows where `errorCode` lives in the pino line. Skip-reason rows carry all data in the `intent` JSON.
- **Target SELL fills**: targets only redeem (no SELL). The snapshot is the truth.
- **Latency (D1)**: needs `mirror-pipeline` Loki lines. Not material once structural classes dominate.
