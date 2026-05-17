---
id: poly.target-profile.swisstony
type: research
title: "Target profile — swisstony (0x204f72f35326db932158cba6adff0b9a1da95e14)"
state: Active
status: draft
trust: draft
created: 2026-05-16
updated: 2026-05-16
owner: derekg1729
domain: poly_target_alpha
entry_type: finding
confidence_pct: 75
implements: work/charters/POLY_WALLET_RESEARCH.md
cites:
  - work/charters/POLY_WALLET_RESEARCH.md
  - docs/research/poly/2026-05-16-rn1-swisstony-aug2025-data-summary.md
  - docs/research/2026-05-16-swisstony-rn1-alpha.md
  - docs/research/poly/target-profile.rn1.md
tags: [poly, copy-target, swisstony, target-profile, operational-knowledge]
summary: "Target profile — swisstony (0x204f72f35326db932158cba6adff0b9a1da95e14)"
read_when: "Reviewing copy-target operational knowledge; before tuning trade algorithm config."
---

# Target profile — swisstony

> Companion to [target-profile.rn1.md](./target-profile.rn1.md). Same strategy family (directional + hedge), different scale and resolution-velocity. See RN1 profile for shared mechanics; this file documents what's specific to swisstony.

## Identity

| Field             | Value                                          |
| ----------------- | ---------------------------------------------- |
| Address           | `0x204f72f35326db932158cba6adff0b9a1da95e14`   |
| Polymarket handle | swisstony                                      |
| Label (DB)        | `swisstony` (kind=`copy_target`)               |
| Prod wallet_id    | `8c466f41-f6d0-4db2-b9fe-5c002b98f4fc`         |
| Candidate-a id    | `20875825-a325-4df9-8593-dee42c45c509`         |
| First active      | 2025-08-10 (per `poly_trader_user_pnl_points`) |

## Strategy classification

**Same family as RN1**: directional bets with risk-management hedges, 100% BUY / 0% SELL, exit via redemption + neg-risk converter. Differences from RN1:

- **Slightly higher hedge ratio**: lifetime median 17% (vs RN1's 19%) on paired-condition cost imbalance
- **Bigger volume per dollar of profit**: swisstony deployed $53M in Aug-Nov 2025 to earn ~$1.6M; RN1 deployed $20M to earn $1.4M → swisstony's edge per deployed dollar is ~half of RN1's
- **Slow resolution velocity**: -$1.7k realized vs +$739k unrealized cashPnl (May 2026 snapshot window) suggests swisstony trades longer-duration markets that haven't matured. RN1's +$1.04M realized in the same window shows faster turnover.

### Signatures (evidence)

| Signature                                | Measurement                                                  | Confidence |
| ---------------------------------------- | ------------------------------------------------------------ | ---------- |
| 100% BUY, 0% SELL                        | 129,267 BUY / 0 SELL in last 7 days (prod)                   | 99%        |
| Both-token coverage on most $ volume     | 97% of last-7d $ volume on paired-token conditions           | 95%        |
| Median hedge = 17% of primary cost basis | Lifetime snapshot data, `min/max(cost)` per paired condition | 90%        |
| 38% of paired conditions have hedge <10% | Stronger directional tilt than RN1                           | 90%        |

## Lifetime P/L trajectory

| Month       | Cumulative P/L | Δ from prior month |
| ----------- | -------------: | -----------------: |
| 2025-08     |          -$24k |                  — |
| 2025-09     |         -$144k |             -$120k |
| 2025-10     |          +$36k |             +$180k |
| **2025-11** |        +$1.55M |            +$1.51M |
| 2025-12     |        +$3.14M |            +$1.58M |
| 2026-01     |        +$3.90M |             +$764k |
| 2026-02     |        +$4.50M |             +$601k |
| 2026-03     |        +$5.64M |            +$1.14M |
| 2026-04     |        +$6.76M |            +$1.12M |
| 2026-05     |        +$8.11M |            +$1.35M |

**Lifetime: ~$8.1M over 9 months.** Notable: drawdown to -$144k in Sep 2025 before strategy "clicked" in Oct-Nov. RN1 had no comparable drawdown. swisstony's curve is steeper post-inflection but had a real loss period at the start.

## Activity scale evolution (candidate-a backfill, Aug-Nov 2025)

| Month   |   Fills | Conditions | $ deployed |
| ------- | ------: | ---------: | ---------: |
| 2025-08 |   3,304 |        342 |      $669k |
| 2025-09 |  21,919 |      1,857 |     $4.48M |
| 2025-10 |  93,739 |      4,036 |    $19.41M |
| 2025-11 | 244,996 |      6,908 |    $29.09M |

**44x ramp Aug → Nov 2025** ($669k → $29.09M). Even more aggressive scaling than RN1's 17x. Aug 2025 is the smallest-budget reference point (342 conditions, $669k).

## Differences vs RN1 that matter for copy-trade design

| Dimension                   | RN1     | swisstony                          | Implication for our mirror                                            |
| --------------------------- | ------- | ---------------------------------- | --------------------------------------------------------------------- |
| Median hedge ratio          | 19%     | 17%                                | Filter logic identical; both want primary-leg priority                |
| $ deployed Aug-Nov 2025     | $20M    | $53M                               | swisstony is bigger; small-budget mirror harder                       |
| Realized P/L (May 2026 13d) | +$1.04M | -$1.7k                             | RN1 cashes faster; swisstony's edge is locked in unresolved positions |
| Market duration             | shorter | longer                             | Mirror-order TTL needs to handle longer holds for swisstony           |
| swisstony p99 cost          | $30,809 | (lifetime data; comparable to RN1) | Same tail constraint                                                  |

## Anti-patterns (shared with RN1)

| Misread                       | Why wrong                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| "Complete-basket arbitrage"   | Hedge is 17% median, not 100%. Strategy is directional.                                          |
| "Market maker"                | 0 sells in 230k+ fills.                                                                          |
| "High-edge-per-dollar trader" | swisstony earns half what RN1 earns per deployed dollar. Higher volume, comparable absolute P/L. |

## Copy-trade implications at our budget

If RN1's pareto is the better template (~42% capture at $100 cap on realized P/L for May 2026 13-day window), swisstony's would be _worse_ per-dollar because:

1. Realized P/L is much smaller (less mature positions)
2. More volume per dollar of realized profit

**Recommendation**: prioritize RN1 mirror first; add swisstony only after RN1 mirror validates positive realized-P/L for 2 weeks. swisstony is a confirmation/diversification target, not the primary.

## Capability requirements

Same as RN1 — see [target-profile.rn1.md §Capability requirements](./target-profile.rn1.md#capability-requirements-to-mirror-rn1-effectively). Notable difference: swisstony's longer-duration markets stress mirror-order TTL more than RN1's faster cycles.

## Open questions specific to swisstony

1. **Why the Sep 2025 drawdown?** -$144k cumulative before recovery. A regime-change moment or a single bad bet? Answerable on Aug-Sep 2025 backfilled fills NOW (per-condition cumsum + outcome join when ticks catch up).
2. **What's in the +$739k unrealized?** Polymarket reports +$739k cashPnl with -$1.7k realized — mostly mark-to-market on open long-duration positions. Watching `poly_trader_user_pnl_points` over coming weeks will show whether this mark realizes.
3. **Aug 2025 condition signature** — 342 conditions across $669k = $1,956 avg per condition (vs RN1's August $686k / 1,020 = $673 avg). swisstony took bigger bets even when small. Worth verifying against backfilled data.

## Citations

Same as RN1 profile (see [target-profile.rn1.md §Citations](./target-profile.rn1.md#citations)).

#poly #copy-target #swisstony #target-profile #directional-with-hedge #operational-knowledge
