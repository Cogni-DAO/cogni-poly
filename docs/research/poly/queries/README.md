---
id: poly.research.queries.index
type: research
title: "Saved queries — RN1 + swisstony copy-target research"
summary: "Index of reusable + reviewable SQL queries used in copy-target analysis. Every numeric claim in copy-target docs traces to one of these."
read_when: "Reviewing any claim in copy-target research; reproducing a prior result; auditing recommendation methodology."
status: draft
trust: draft
created: 2026-05-16
owner: derekg1729
---

# Saved queries for copy-target research

> **Why this directory exists.** Every numeric claim in [`copy-target-north-star-2026-05-16.md`](../copy-target-north-star-2026-05-16.md), [`target-profile.rn1.md`](../target-profile.rn1.md), [`target-profile.swisstony.md`](../target-profile.swisstony.md), and [`2026-05-16-rn1-swisstony-aug2025-data-summary.md`](../2026-05-16-rn1-swisstony-aug2025-data-summary.md) must trace to a query in this directory. The user has explicitly required reproducibility; an agent claiming "$545 is the floor" without a runnable query is not allowed.

## How to use

Each `.sql` file has a header block with: purpose, datasource, expected schema, last validated date + result hash. To re-run any query:

```bash
./scripts/grafana-postgres-query.sh "$(cat docs/research/poly/queries/<file>.sql)" <datasource-uid>
```

Datasources:

- `cogni-production-poly-postgres` — live wallet observation, current 7d data
- `cogni-candidate-a-poly-postgres` — backfilled Aug-Nov 2025 + Jul 2025 (RN1 only)

## Query inventory

| ID  | File                                          | What it answers                                        | Datasource  | Last validated |
| --- | --------------------------------------------- | ------------------------------------------------------ | ----------- | -------------- |
| Q01 | `q01-wallet-identity.sql`                     | Resolve RN1 + swisstony trader_wallet_id by label      | both        | 2026-05-16     |
| Q02 | `q02-rn1-lifetime-pnl.sql`                    | RN1 lifetime PnL trajectory from user-pnl-api          | prod        | 2026-05-16     |
| Q03 | `q03-rn1-buy-vs-sell.sql`                     | Confirm 100% BUY signature                             | prod        | 2026-05-16     |
| Q04 | `q04-rn1-monthly-deployment.sql`              | Per-month fills, $ volume, conditions                  | candidate-a | 2026-05-16     |
| Q05 | `q05-rn1-at-fill-cost-pXX-per-month.sql`      | At-fill cumulative cost percentiles per month          | candidate-a | 2026-05-16     |
| Q06 | `q06-rn1-realized-pnl-by-cost-band.sql`       | **Load-bearing**: P/L per cost band on resolved subset | candidate-a | 2026-05-16     |
| Q07 | `q07-swisstony-realized-pnl-by-cost-band.sql` | Same for swisstony                                     | candidate-a | 2026-05-16     |
| Q08 | `q08-rn1-win-rate-by-cost-band.sql`           | Win rate gradient                                      | candidate-a | 2026-05-16     |
| Q09 | `q09-rn1-sport-x-cost-band.sql`               | Sport × cost-band cross-tab                            | candidate-a | 2026-05-16     |
| Q10 | `q10-outcomes-coverage.sql`                   | % of conditions with outcomes (gating on freshness)    | candidate-a | 2026-05-16     |

## Validation protocol (per user directive)

For every load-bearing claim:

1. Save the SQL with a clear header
2. Re-run identically — confirm match
3. Run a **second-angle query** that measures the same thing differently (e.g., `cost_after` from fills cumsum vs `total_cost` from per-condition sum)
4. If results agree within tolerance → claim confidence high
5. If they disagree → flag with `⚠️ DISAGREEMENT` in the conclusion doc

## Why this directory matters

I have made errors in this investigation that the user has had to catch (basket-arb misclassification, bundesliga over-claim, within-month bucketing artifact). Saved queries make those errors auditable and recoverable. Future agents should never recompute "what does RN1 trade" without running the saved query first.
