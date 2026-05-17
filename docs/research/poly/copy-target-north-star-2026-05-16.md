---
id: poly.copy-target.north-star
type: research
title: "North-star — copy-trading RN1 + swisstony: what we know, what we're betting on, what's still open"
state: Active
status: draft
trust: draft
created: 2026-05-16
updated: 2026-05-16 (late evening — corrected after validation pass)
owner: derekg1729
domain: poly_target_alpha
entry_type: conclusion
confidence_pct: 65
implements: work/charters/POLY_WALLET_RESEARCH.md
cites:
  - docs/research/poly/target-profile.rn1.md
  - docs/research/poly/target-profile.swisstony.md
  - docs/research/poly/2026-05-16-rn1-swisstony-aug2025-data-summary.md
  - work/charters/POLY_WALLET_RESEARCH.md
tags: [poly, copy-target, rn1, swisstony, north-star, conclusion]
summary: "North-star — copy-trading RN1 + swisstony: what we know, what we're betting on, what's still open"
read_when: "Reviewing copy-target operational knowledge; before tuning trade algorithm config."
---

# North-Star — Copy-Trading RN1 + Swisstony

> **Why this doc exists.** Multiple investigations, two reversals, and a growing set of corrections — this is the single page where the conclusions consolidate so the next agent (and you) can pick up without re-deriving anything. Each claim here cites a specific finding in the per-target profile or data-summary docs. If you only read one file, read this one.

## ⚠️ Critical reproducibility + stability caveat (added late 2026-05-16)

Several earlier claims were unstable — they shifted materially within hours as outcome fan-out progressed from 6% → 8% resolved coverage. **Every numeric claim in this doc now traces to a saved query** in [`queries/`](./queries/) with run-by-run results tracked. Specifically:

- The "$545-$5k profit band" recommendation was tested at three resolution snapshots; magnitudes per band shifted by up to 6 percentage points (sign-flips). **The direction is supported by cross-validation against [Q11](./queries/q11-rn1-realized-pnl-by-fill-cost-after.results.md) — a different bucketing that matches what `bet-sizer-v1` actually sees per-fill** — but the precise per-band magnitudes are NOT load-bearing until coverage exceeds 30%.

- Earlier "win-rate gradient 64% → 100%" claim is technically true but [misinterpreted](./queries/q08-rn1-win-rate-by-cost-band.results.md): the win rate is mostly a **pairing-rate signal** (one of two tokens always wins for paired positions), not a conviction signal. The actual conviction signal is the fill-level win rate from Q11, which goes 39% → 54% (and that IS decision-relevant).

**See `queries/README.md` for the full validation protocol.**

## What we know (high confidence)

| Claim                                                                                                                          | Source                                                  |                   Confidence |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------: |
| RN1 lifetime PnL = **+$9.0M** (Jul 2025 → May 2026, ~10 months)                                                                | `poly_trader_user_pnl_points` from prod                 |                          99% |
| swisstony lifetime PnL = **+$8.1M** (Aug 2025 → May 2026, ~9 months)                                                           | same                                                    |                          99% |
| Both wallets are **100% BUY, 0% SELL** (exit only via redemption / neg-risk converter)                                         | 246k+ prod fills, 1 sell                                |                          99% |
| Both run **directional bets + small hedges**, NOT basket arbitrage                                                             | Cost-imbalance test: median hedge = 17-23% of primary   |                          95% |
| RN1 trades **sports only** — soccer (Bundesliga, PL, La Liga, Serie A, Ligue 1, UCL), NFL, NBA, MLB, NHL, MMA, US Open tennis  | event_slug analysis, Aug-Nov 2025 backfill              |                          95% |
| RN1's strategy was **already paired-heavy from day one** — 97% paired even in Aug 2025                                         | Eventual classification on 8,628 conditions             |                          95% |
| RN1 deployed **$2.7k/day in July 2025** → **$403k/day in Nov 2025** (147× growth in 5 months)                                  | Backfill aggregate                                      |                          99% |
| Return rate ~6.5–8.6%/month, **stable across all scales** (Jul-Nov 2025)                                                       | user-pnl-api Δ vs deployment                            |                          95% |
| Win rate **gradient by bet size** — 64% on ≤$100 bets → 100% on $1,229-$5,000 bets                                             | Realized P/L on 527 resolved conditions (6.1% of total) | **85%** (sample size caveat) |
| Per-condition realized P/L is **negative on small (≤$545) and very large (>$5,000) bets**; positive in middle $545-$5,000 band | Same                                                    |                      **80%** |
| Outcome fan-out is **uniform across months** (no time bias)                                                                    | Per-month resolved coverage 5.8-7.7%                    |                          95% |

## The north-star recommendation

**Copy-trade RN1 with a config that mirrors only the profit-band of their bets, scaling proportionally:**

```ts
{
  wallet: "RN1",
  sizing_policy: "target_percentile_scaled",
  sizing_min_target_usdc: 545,         // SKIP RN1's <$545 bets (only 64% win rate, ~0% return)
  sizing_max_target_usdc: 5000,        // CEILING at edge peak; avoids >$5k loss tail (-3.7%)
  TOP_TARGET_SIZE_SNAPSHOTS: { p50: 1500, p75: 2500, p90: 4000, p95: 5000, p99: 5000 },
  max_usdc_per_condition: 30,          // scales floor ($5) to $30 across band
  // poly_wallet_grants:
  daily_cap_usdc: 100,                 // budget throttle
  total_at_risk_usdc: 1000             // hard ceiling at user's current budget
}
```

**Captures**: 41.4% of current RN1 fills ($5.09M weekly target $ in band)
**Throttled to**: ~10 new mirrors/day at $100 daily cap
**Expected P/L at $1k budget**: $100-$200/month (10-20% APR)
**Confidence**: 70% — directionally right, magnitudes depend on more outcome data

## 🚨🚨 FURTHER CORRECTION — swisstony at fill level is monotonic, not barbell (added iteration 10)

The "barbell" finding (Q07) was at the CONDITION level. At the FILL level (Q12 — what `bet-sizer-v1` actually sees per decision), swisstony's winner rate is **monotonic increasing**:

| Bucket (cost_after at fill) |   swisstony winner % |
| --------------------------- | -------------------: |
| ≤ $100                      | 46.26% (negative EV) |
| $100-$545                   |               49.75% |
| $545-$1,229                 |               51.88% |
| $1,229-$5,000               |           **56.30%** |
| > $5,000                    |           **60.16%** |

**The strongest swisstony edge lives in their >$5,000 cost_after bets, which we cannot proportionally mirror at $1k budget.**

**Implication: at $1k, mirror RN1 only.** swisstony becomes valuable at $30k+ budget where their >$5k edge becomes reachable.

The condition-level "small bets earn +11%" was an artifact of which conditions resolve fastest — a sample bias that the fill-level analysis controls for.

## 🚨 swisstony has a DIFFERENT profile (added iteration 7)

I assumed swisstony's edge profile would mirror RN1's since both are multi-league sports traders. **Wrong.** Realized P/L per cost band on swisstony's 855 resolved conditions (Aug-Nov 2025):

| Cost band     | swisstony conds | swisstony cost | swisstony pnl | **swisstony % return** |     RN1 comparison |
| ------------- | --------------: | -------------: | ------------: | ---------------------: | -----------------: |
| ≤ $100        |             200 |          $7.2k |        +$1.2k |          **+17.0%** ⭐ |         RN1: +2.4% |
| $100-$545     |             180 |           $48k |         +$384 |                  +0.8% |         RN1: -0.8% |
| $545-$1,229   |             109 |           $90k |        -$3.0k |              **-3.4%** |         RN1: +4.7% |
| $1,229-$5,000 |             201 |          $506k |       +$17.4k |                  +3.4% | **RN1: +10.4%** ⭐ |
| > $5,000      |             165 |         $3.31M |        +$469k |          **+14.2%** ⭐ |         RN1: -3.7% |

**swisstony = barbell profile** (wins at extremes, loses in middle).
**RN1 = upper-middle profile** (wins at $1.2-5k, loses at extremes).

Same target family (multi-league sports, directional+hedge), opposite size economics. **Each wallet needs a different mirror config.**

### swisstony copy-trade config (at $1k budget, ≤$100 band only — the part we can afford)

```ts
{
  wallet: "swisstony",
  sizing_policy: "target_percentile_scaled",
  sizing_min_target_usdc: 25,          // skip target's <$25 (too small for our $5 floor)
  sizing_max_target_usdc: 100,         // ceiling at swisstony's ≤$100 profit band
  TOP_TARGET_SIZE_SNAPSHOTS: { p50: 50, p75: 75, p90: 95, p95: 100, p99: 100 },
  max_usdc_per_condition: 10,          // proportional cap; small-band mirror
  daily_cap_usdc: 50,
  total_at_risk_usdc: 500              // budget split: $500 swisstony + $500 RN1
}
```

To mirror swisstony's >$5k bets (where +$469k of edge lives), you need ~$50k+ working capital. Out of reach at $1k.

## What budget you actually need

Polymarket min order = $0.50-$5. This dominates economics at low budgets.

|      Budget | What you can do                                  | Est. monthly P/L | Verdict                |
| ----------: | ------------------------------------------------ | ---------------: | ---------------------- |
|         $1k | Filter to $545-$5k band, $5-$30/pos, ~10 new/day |        $100-$200 | ⚠️ Marginal but viable |
|         $5k | Same filter, $5-$50/pos, ~35 new/day             |        $500-$900 | ✅ MVP                 |
| **$15-30k** | **Match Aug 2025 absolute scale**                |      **$1.5-3k** | ✅ Strong              |
|    $50-100k | Sep-Oct 2025 shape                               |           $5-10k | ✅ Comfortable         |
|      $500k+ | Full proportional of current flow                |            $30k+ | ✅ Full replication    |

**Bottom line**: **$5-10k is the minimum viable budget**; **$15-30k is the recommended target** to copy RN1's "first $1.4M profitable period" shape.

## Sport × cost-band cross-tab (added iteration 6)

Disentangles the cost-band-vs-sport confound. Within the **profit band $545-$5,000**:

| Sport                                                                | Conds |  Cost |  **% return** |
| -------------------------------------------------------------------- | ----: | ----: | ------------: |
| nhl                                                                  |    10 |  $20k | **+27.2%** ⭐ |
| other-sport (LaLiga, SerieA, Ligue1, UCL, US Open, college football) |   151 | $278k |  **+9.6%** ⭐ |
| nba                                                                  |     5 |  $16k |         +9.2% |
| pl (Premier League soccer)                                           |    11 |  $22k |         +6.6% |
| non-sport                                                            |    12 |  $12k |         +5.1% |
| mlb                                                                  |     6 |   $6k |         -8.6% |
| nfl                                                                  |     8 |  $17k |         -8.3% |
| bundes (Bundesliga)                                                  |     9 |  $25k | **-11.2%** ⚠️ |

**NFL contributed $199k to the >$5k cost band at -14.1% return — single largest loser. Bundesliga is consistently negative across all bands.** These are 8-9 condition samples → wait for outcome fan-out before locking in a sport filter, but trend is clear: copy MORE soccer + tennis + NHL, copy LESS NFL + Bundesliga.

## What's still open (gating)

| Open question                             | Why it matters                                                                                                           | Gating signal                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Outcome fan-out for backfilled conditions | Currently 6% resolved → P/L numbers have ±3% wobble per band                                                             | Need 30%+ coverage; growing ~50-80/hour, so ~3-5 days                                                      |
| Sport × cost-band cross-tab               | The cost-band P/L finding may confound with sport mix (NFL/Bundesliga losses might be from >$5k positions)               | Same — needs outcome fan-out                                                                               |
| Position resolution velocity              | Capital rotation rate underlies the budget math                                                                          | `poly_market_outcomes.resolved_at` is null on all rows — need to fix the writer or join via Gamma metadata |
| swisstony deep-dive                       | Smaller-scale period for swisstony starts 2025-08-10; data is loaded but not analyzed at the per-band realized P/L level | After RN1 picture stabilizes                                                                               |

## What was wrong before (anti-pattern preservation)

These were claimed in earlier passes; each was falsified by data. Documenting so the next agent doesn't repeat:

| Wrong claim                                          | Reality                                                                                                                                       | Why I was wrong                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "Complete-basket arbitrage"                          | Directional + small hedge (17-23%)                                                                                                            | VWAP_a + VWAP_b ≈ $1.00 is market efficiency, NOT a strategy signature. Must test cost imbalance. |
| "16% single-side in Aug 2025"                        | 2.6% in eventual classification; positions span multiple months                                                                               | Within-month bucketing splits long-running positions                                              |
| "Filter on small Jul shape ≤$545 = copy what worked" | The ≤$545 band only earns 2.4% (small bets, 64% win rate). The PROFIT band is $545-$5,000.                                                    | Conflated "shape at small budget" with "profit at small budget". They're different.               |
| "Bundesliga was the only sport in Aug 2025"          | Bundesliga was the 5th-largest category in August (5% of $); soccer overall (PL + La Liga + Serie A + Ligue 1 + UCL + Bundesliga) is dominant | Looked at top events by condition count, not by $ volume                                          |
| "Outcome fan-out in hours-to-days"                   | Actually 50-80 conds/hour pace; full coverage of 8,628 will take 5-10 days                                                                    | Underestimated rate-limit + tick cadence                                                          |

## North-star direction (the work plan from here)

**Phase 1 (now → 5 days):** Wait for outcome fan-out to reach 30%+ coverage. Re-validate the cost-band P/L finding with stronger sample. Cross-tab sport × cost-band to disentangle confounders.

**Phase 2 (after fan-out):** Lock in the precise filter band based on realized P/L. Flight the revised config (`sizing_min_target_usdc=545, sizing_max_target_usdc=5000`) on candidate-a. Run paper-mirror for 1 week to validate expected fill rate + capture.

**Phase 3 (after paper validation):** Promote to production live-mirror at $1k budget. Observe realized P/L for 2 weeks. If positive, scale budget toward $5-10k.

**Phase 4 (post-validation):** Repeat analysis loop for swisstony. Apply same filter band methodology. Probably similar config given strategy family is shared.

**Phase 5 (vNext):** Add the per-sport filter to mirror logic. NHL + "other" categories are highest-return; NFL + Bundesliga are negative-return. If sport-level filter is robust to bigger samples, it's another precision lever.

## Files map

| File                                                                  | Purpose                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `docs/research/poly/copy-target-north-star-2026-05-16.md`             | **THIS FILE** — single-page conclusions + direction                           |
| `docs/research/poly/target-profile.rn1.md`                            | Per-wallet operational profile for RN1                                        |
| `docs/research/poly/target-profile.swisstony.md`                      | Per-wallet operational profile for swisstony                                  |
| `docs/research/poly/2026-05-16-rn1-swisstony-aug2025-data-summary.md` | Data inventory + methodology + all numbered findings F1-F7                    |
| `docs/research/2026-05-16-swisstony-rn1-alpha.md`                     | SUPERSEDED first-pass with the basket-arb misread; preserved for traceability |
| `work/charters/POLY_WALLET_RESEARCH.md`                               | Charter; now cross-links to target profiles                                   |

#poly #copy-target #north-star #rn1 #swisstony #conclusion #budget-recommendation
