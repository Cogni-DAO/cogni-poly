---
id: poly.target-profile.rn1
type: research
title: "Target profile — RN1 (0x2005d16a84ceefa912d4e380cd32e7ff827875ea)"
state: Active
status: draft
trust: draft
created: 2026-05-16
updated: 2026-05-16
owner: derekg1729
domain: poly_target_alpha
entry_type: finding
confidence_pct: 80
implements: work/charters/POLY_WALLET_RESEARCH.md
cites:
  - work/charters/POLY_WALLET_RESEARCH.md
  - docs/research/poly/2026-05-16-rn1-swisstony-aug2025-data-summary.md
  - docs/research/2026-05-16-swisstony-rn1-alpha.md
supersedes: null
tags: [poly, copy-target, rn1, target-profile, operational-knowledge]
summary: "Target profile — RN1 (0x2005d16a84ceefa912d4e380cd32e7ff827875ea)"
read_when: "Reviewing copy-target operational knowledge; before tuning trade algorithm config."
---

# Target profile — RN1

> **Purpose.** Operational knowledge about how RN1 generates edge. Future agents starting at `POLY_WALLET_RESEARCH.md` see only "✅ COPY based on smooth +$6.5M curve." That's screening-in, not strategy understanding. This file fills the gap so the next agent doesn't repeat the basket-arb misclassification I made.

## Identity

| Field             | Value                                          |
| ----------------- | ---------------------------------------------- |
| Address           | `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`   |
| Polymarket handle | RN1                                            |
| Label (DB)        | `RN1` (kind=`copy_target`)                     |
| Prod wallet_id    | `a58df098-a862-4758-8954-7d14a2623ade`         |
| Candidate-a id    | `43c12d6d-7847-467a-83e2-f41b901fca59`         |
| First active      | 2025-07-09 (per `poly_trader_user_pnl_points`) |

## Strategy classification

**Directional bets with risk-management hedges.** Buys large primary positions on the side they believe in, then takes a small hedge on the opposite token. Holds to resolution. Never sells (exit = redemption + neg-risk converter).

### Signatures (evidence, all from prod `cogni-production-poly-postgres` and candidate-a backfill)

| Signature                                   | Measurement                                                             | Confidence |
| ------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
| 100% BUY, 0% SELL                           | 117,114 BUY / 1 SELL in last 7 days (prod)                              | 99%        |
| Both-token coverage on most $ volume        | 98% of last-7d $ volume on conditions where both tokens held            | 95%        |
| Median hedge = 19-23% of primary cost basis | `min(cost)/max(cost)` per paired condition, p50 from lifetime snapshots | 90%        |
| 32-36% of paired conditions have hedge <10% | Strong directional tilt; hedge is insurance not basket-arb              | 90%        |
| Held to resolution                          | No sells; cash extraction via market resolution payout                  | 95%        |

### Anti-patterns (what RN1 LOOKS like but isn't)

| Easy misread                  | Why it's wrong                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Complete-basket arbitrage"   | VWAP_a + VWAP_b ≈ $1.00 is just market efficiency on binaries, not a strategy signature. The decisive test is share/cost imbalance, which shows 18-23% hedge ratio. (I made this exact misread in the first pass — preserved here so the next agent doesn't.) |
| "Market maker"                | 0 sells in 230k fills. No spread capture possible.                                                                                                                                                                                                            |
| "Neg-risk subsidy specialist" | Neg-risk = only 22% of fills, 24% of $ volume. Not their primary surface.                                                                                                                                                                                     |

## Lifetime P/L trajectory (from `poly_trader_user_pnl_points` 1d)

| Month       | Cumulative P/L | Δ from prior month |
| ----------- | -------------: | -----------------: |
| 2025-07     |         +$2.9k |                  — |
| 2025-08     |          +$50k |              +$47k |
| 2025-09     |         +$200k |             +$150k |
| 2025-10     |         +$643k |             +$443k |
| **2025-11** |        +$1.43M |             +$787k |
| 2025-12     |        +$2.31M |             +$880k |
| 2026-01     |        +$4.33M |        **+$2.02M** |
| 2026-02     |        +$5.23M |             +$900k |
| 2026-03     |        +$6.51M |            +$1.28M |
| 2026-04     |        +$7.83M |            +$1.32M |
| 2026-05     |        +$9.00M |            +$1.17M |

**Lifetime: ~$9.0M over 10 months. Smooth monotonic uptrend with no >$300k drawdown.**

## Activity scale evolution (from candidate-a backfill, Aug-Nov 2025)

| Month   |   Fills | Conditions | $ deployed |
| ------- | ------: | ---------: | ---------: |
| 2025-07 |     354 |         27 |       $10k |
| 2025-08 |  15,669 |      1,020 |      $686k |
| 2025-09 |  22,925 |      1,451 |     $1.74M |
| 2025-10 |  60,896 |      2,577 |     $6.03M |
| 2025-11 | 116,698 |      3,693 |    $12.10M |

**Strategy scales 17x from Aug to Nov 2025** ($686k → $12.10M). Aug-Sep 2025 is the closest-shape match for our budget level.

## Exit mechanism

**Two paths, no third:**

1. **Market resolution** — at end-of-market, winning tokens pay $1, losing tokens pay $0. RN1 redeems via the standard CTF `redeemPositions` call.
2. **Neg-risk converter** — for multi-outcome events, holding a complete NO set (one NO per outcome) can be converted via the neg-risk converter contract for `(k-1) × $1 / share`. RN1 uses this where their position structure allows.

No third path: zero sells across full history. This means **paper P/L (Polymarket's `cashPnl`) is unreliable as a copy-trade target metric** — only realized P/L (cashed via redemption/conversion) reflects strategy. My first pareto-budget pass on `cashPnl` produced misleading negative numbers; the realized-P/L pareto (~42% capture at $100 cap in May 2026 13-day window) is the truer signal.

## Budget reality check (added 2026-05-16 evening)

RN1's `poly_trader_user_pnl_points` shows **+$321 cumulative PnL on 2025-07-13** (16 days into wallet life). That's the smallest-budget anchor. Full July 2025 backfill (4,044 fills):

| Month       |   Fills | $/day deployed | p50 cost-at-fill |  **p95** |     Max |
| ----------- | ------: | -------------: | ---------------: | -------: | ------: |
| **2025-07** |   4,044 |     **$2,742** |              $78 | **$545** |  $1,055 |
| 2025-08     |  15,669 |        $22,114 |             $202 |   $1,229 |  $9,653 |
| 2025-09     |  22,925 |        $57,869 |             $437 |   $5,242 | $16,462 |
| 2025-10     |  60,896 |       $194,514 |             $977 |   $9,594 | $31,357 |
| 2025-11     | 116,698 |       $403,474 |           $1,385 |  $12,839 | $61,542 |

RN1 scaled 147× in deployment over 5 months. Return rate stable at 6.5–8.6%/month across all scales.

**Budget recommendation matrix (with Polymarket's $0.50–$5 min order constraint):**

|     Budget | What's actually possible                                    |  Est. monthly P/L | Verdict                       |
| ---------: | ----------------------------------------------------------- | ----------------: | ----------------------------- |
|        $1k | Min-order-dominated; ~14 concurrent at $5–15; ~0.3% capture | $30–80 (3–8% APR) | ❌ Too small for proportional |
|        $3k | $10–25/pos; ~1% capture                                     |          $150–250 | ⚠️ Marginal                   |
| **$5–10k** | **Full Jul-shape mirror; 10–20% capture**                   |      **$400–900** | ✅ **MVP**                    |
|    $15–30k | Aug-2025 shape                                              |           $1.5–3k | ✅ Strong                     |
|   $50–100k | Sep-Oct shape                                               |            $5–10k | ✅ Comfortable                |
|     $500k+ | Current-day proportional                                    |             $30k+ | ✅ Full replication           |

**The minimum viable budget to effectively copy-trade RN1 is $5–10k.** Below this, Polymarket's $5 order floor dominates and proportional mirroring breaks down. Above $5k, the strategy maps cleanly to RN1's July 2025 small-but-profitable shape (the period when they grew from $0 → $50k cumulative PnL at consistent ~7%/month edge).

## CRITICAL UPDATE (2026-05-16 late) — realized P/L inverts the shape-based recommendation

Outcomes fan-out reached 527 resolved conditions (6.1% of 8,628). Realized P/L per cost band:

| Cost band         |   Conds | **Win rate** |      Per-cond avg |   % return |
| ----------------- | ------: | -----------: | ----------------: | ---------: |
| ≤ $100            |     134 |    **64.2%** |         $32 → $32 |        ~0% |
| $100-$545         |     156 |        94.2% |       $275 → $272 |      -0.8% |
| $545-$1,229       |      83 |        96.4% |       $856 → $884 |      +4.7% |
| **$1,229-$5,000** | **117** |     **100%** |   $2,545 → $2,812 | **+10.4%** |
| > $5,000          |      73 |        98.6% | $14,236 → $13,857 |      -3.7% |

**Win rate is monotonic-increasing with cost** (64% → 100%). RN1's bet size IS their conviction signal.

**Implication for copy-trade**: filtering on small-shape (≤$545) mirrors the _unprofitable_ subset of RN1's strategy. The profit edge lives at **$545-$5,000 cumulative cost**. Above $5k there's a loss tail (small sample, 73 conds).

## Precise copy-trade config — REVISED based on realized P/L

```ts
{
  wallet: "RN1",
  sizing_policy: "target_percentile_scaled",
  sizing_min_target_usdc: 545,         // skip RN1's <$545 low-conviction bets (~0% return)
  sizing_max_target_usdc: 5000,        // ceiling at edge peak; avoids >$5k loss tail
  TOP_TARGET_SIZE_SNAPSHOTS: {
    p50: 1500, p75: 2500, p90: 4000, p95: 5000, p99: 5000
  },
  max_usdc_per_condition: 30,          // mid of user's current $15-$50 range
  daily_cap_usdc: 100,                 // throttle on poly_wallet_grants
  total_at_risk_usdc: 1000
}
```

**Captures 41.4% of current RN1's fills** ($5.09M weekly target volume in band).
**Expected**: ~10 new mirrors/day, $5-$30 each, avg $12. P/L estimate: $100-$200/mo at $1k = 10-20% APR.

### Misalignment with prior config

|                   | Prior config                                                          | Revised config                           |
| ----------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `min_target_usdc` | $1,659 (current 2026-05-03 p75)                                       | $545 (Jul p95)                           |
| `max_target_usdc` | $32,659 (current p99)                                                 | $5,000 (edge ceiling)                    |
| Effect            | Skipped profitable $545-$1,659 mid-band; scaled across loss-tail >$5k | Catches profit-band; truncates loss-tail |

## Precise copy-trade config for July-2025 profile sizing (at $1k budget) — SUPERSEDED

```ts
{
  wallet: "RN1",
  sizing_policy: "target_percentile_scaled",
  sizing_min_target_usdc: 25,
  sizing_max_target_usdc: 545,        // Jul p95 — scaling ceiling
  TOP_TARGET_SIZE_SNAPSHOTS: {        // Jul 2025 distribution
    p50: 78, p75: 221, p90: 430, p95: 545, p99: 758
  },
  max_usdc_per_condition: 15,
  max_usdc_per_trade: 15,
  // CAPS_LIVE_IN_GRANT — set on poly_wallet_grants:
  daily_cap_usdc: 100,
  total_at_risk_usdc: 1000
}
```

Captures 30.2% of current RN1's fills ($994k weekly target volume in band) — but daily cap throttles us to ~10 new mirrors/day. Expected: $30–80/month P/L at 3–8% APR.

## Precise copy-trade config for Aug-2025 profile sizing (at $15–30k budget)

**(Refined 2026-05-16 after 5-iteration validation; see [data-summary §F4-F7](./2026-05-16-rn1-swisstony-aug2025-data-summary.md#f4--rn1s-at-fill-cumulative-cost-distribution-per-month-the-metric-bet-sizer-v1-actually-compares).)**

To replicate RN1's Aug 2025 small-budget profile by filtering today's RN1 fills:

```ts
{
  wallet: "RN1",
  sizing_policy: "target_percentile_scaled",
  sizing_min_target_usdc: 17,            // Aug-2025 p10
  sizing_max_target_usdc: 1229,          // NEW knob — Aug-2025 p95 (was: unbounded)
  TOP_TARGET_SIZE_SNAPSHOTS: {           // Aug-2025 small-budget distribution
    p50: 202, p75: 453, p90: 857, p95: 1229, p99: 2484
  },
  max_hedge_fraction_of_position: 0.50,  // was 0.25; Aug-2025 hedge p50 was 0.37
  // unchanged: mirror_max_usdc_per_trade, sizing_min_mirror_position_usdc
}
```

**Expected behavior** (validated on current 7d prod data):

- Captures **42.7%** of current RN1's fills (49,848 / 116,767)
- Captures **$2.28M / $10.94M** weekly target volume in the band
- At our $500/position cap, mirror deploys ~$200-400k weekly at risk

**Required code change**: add `sizing_max_target_usdc` gate in `nodes/poly/app/src/features/copy-trade/plan-mirror.ts` near line 92-115 (existing `below_target_percentile` check). New skip-reason: `above_target_max_usdc`.

**Alternative anchors** (sensitivity from F5):

| Anchor   | p95 cap | Coverage on current flow | RN1 cumulative PnL at end of window |
| -------- | ------: | -----------------------: | ----------------------------------: |
| Aug only |  $1,229 |     42.7% fills / $2.28M |                               +$50k |
| Aug-Sep  |  $3,867 |     66.0% fills / $5.27M |                              +$200k |
| Aug-Nov  | $10,911 |     86.7% fills / $8.35M |                             +$1.43M |

**Confidence on the filter mechanic: 95%+.** Gap-to-100%: realized-P/L validation on the band (blocked on outcome tick fan-out for 8,628 backfilled conditions).

## Copy-trade implications at our budget (lifetime context)

The headline question is whether RN1 is copyable at $0.5-1M total capital.

| Cap per position | Captured % of realized edge (May 2026 13-d) | Capital at risk |
| ---------------: | ------------------------------------------: | --------------: |
|              $25 |                                         22% |           $200k |
|             $100 |                                         42% |           $671k |
|             $500 |                                         64% |          $2.44M |
|            $1000 |                                         73% |          $4.07M |

**Caveat**: this is the May 2026 window when RN1 was at $9M scale. The Aug-Nov 2025 window (smaller account, $1.4M earned) is the right small-budget reference — pareto math on that window awaits outcome/metadata fan-out on the backfilled conditions.

### What we can copy

- ✅ The **directional leg** of each paired-token position (filter out the small hedge or include it as a smaller secondary order)
- ✅ Positions where their cost basis ≤ our cap (median position cost was $170 in May 2026; $50-200 was likely the Aug-Nov shape)
- ✅ Hold-to-resolution exit (don't sell; let `redeemPositions` handle exit)

### What we cannot replicate

- ❌ Their volume (~17k fills/day) — implies automation we may not be running
- ❌ Their tail capture — $5k-$30k positions that drive 82-92% of profit are out of budget
- ❌ Their basket diversification — they hold ~14k positions; we'll hold ~100-1000

## Data quality caveats (as of 2026-05-16)

- Production fill history is shallow (~16 days). Candidate-a now has Aug-Nov 2025 backfill (216k fills) but `poly_market_outcomes` and `poly_market_metadata` haven't fanned out to the 8,628 historical conditions yet (0% metadata, 0.6% outcomes). Wait for tick catch-up before claiming realized-P/L numbers on the 2025 window.
- Polymarket's reported `cashPnl` is mark-to-market on currently-open positions. Trust `realizedPnl` and `poly_trader_user_pnl_points` for copy-trade decisions.

## Capability requirements to mirror RN1 effectively

| Capability                                       | Status                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `redeemPositions` automation                     | Existing redeem-jobs worker (cp1)                                                          |
| Neg-risk converter signing                       | **GAP** — verify before mirroring neg-risk legs                                            |
| 30s poll detection of new fills                  | Existing `wallet-watch`                                                                    |
| Position-aware mirror policy                     | Existing `plan-mirror.ts` v0                                                               |
| Hedge-aware filter (skip / size-down hedge legs) | **GAP** — needed to avoid spending budget on the 18-23% hedge token instead of the primary |
| Long-hold tolerance                              | Existing — but mirror order TTLs may need extension if some markets resolve months out     |

## Open research questions

1. **Aug-Nov 2025 hedge ratio** — was it always 18-23%, or did the hedge size scale with capital? (answerable on backfilled fills NOW; deferred until methodology doc complete)
2. **Aug-Nov 2025 per-condition cost distribution** — what was the median position when they made $1.4M? (answerable NOW)
3. **Realized P/L pareto at Aug-Nov scale** — was small-budget capture better when they were smaller? (blocked on outcome fan-out)
4. **Market category mix** — sports/tech/weather/etc. shares (blocked on metadata fan-out)
5. **Capability gap closure** — is the neg-risk converter signing path implemented? (code-check needed)

## Citations

- `work/charters/POLY_WALLET_RESEARCH.md` — endorses RN1 ✅ COPY
- `docs/research/poly/2026-05-16-rn1-swisstony-aug2025-data-summary.md` — data inventory + methodology
- `docs/research/2026-05-16-swisstony-rn1-alpha.md` — first-pass analysis (contains the basket-arb misread, preserved for traceability)

#poly #copy-target #rn1 #target-profile #directional-with-hedge #operational-knowledge
