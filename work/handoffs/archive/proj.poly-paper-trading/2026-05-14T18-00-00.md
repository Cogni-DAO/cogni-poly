---
id: proj.poly-paper-trading.handoff
type: handoff
work_item_id: proj.poly-paper-trading
status: active
created: 2026-05-14
updated: 2026-05-14
branch: derekg1729/paper-trading-research
last_commit: eafdfc978
---

# Handoff: paper-trading PR 1 — review pointer

## Context

- **PR #38** — https://github.com/Cogni-DAO/cogni-poly/pull/38 (PR 1 of 2). Ships the TS architecture for paper-trading mode on the copy-trade mirror. **Production behaviour unchanged** — paper mode is dormant infrastructure until PR 2 lands the always-paper overlays + sidecar image build.
- **Project doc**: [`work/projects/proj.poly-paper-trading.md`](../projects/proj.poly-paper-trading.md). Includes the full Crawl → Walk roadmap, constraints, dependencies, full `/design` pass, full `/review-design` scorecard, and "what changed" audit-trail sections.
- **Research backing**: [`docs/research/poly-paper-trading-mode.md`](../../docs/research/poly-paper-trading-mode.md). OSS-survey of every Polymarket paper-trading project (agent-next/polymarket-paper-trader chosen as MIT sidecar; homerun's AGPL ruled out; Nautilus' live-paper alpha ruled out). Honest fidelity ceiling discussion — ~96-98% under our strategy constraints (limit-only + ride-to-redemption).
- VMs `candidate-a.vm.cognidao.org` + `preview.vm.cognidao.org` are being provisioned in parallel — PR 2 (always-paper overlays) is blocked on those.

## Review path (45-min walkthrough, in order)

The PR is 8 commits / ~33 files / ~640 LOC of code + ~7500 LOC of docs and migration snapshot. Reviewing in commit order is the cheapest path because each commit is a coherent slice.

| #   | Commit / area                                                                                                                                                     | What to verify                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [`docs/research/poly-paper-trading-mode.md`](../../docs/research/poly-paper-trading-mode.md)                                                                      | The OSS-only-fill-model constraint, the rejection of shadow-attribution, and the fidelity-ceiling honesty (~96-98%, not 99%). If you disagree with any of these the rest of the PR is built on the wrong foundation.                                                                                                                                                                           |
| 2   | [`work/projects/proj.poly-paper-trading.md`](../projects/proj.poly-paper-trading.md) — the **Design Review** scorecard (search `## Design Review`)                | Especially **B1 (paper redemption)** and the four risks. These caught real bugs in my draft — read the "What changed in the design-review pass" section to see what was wrong before the review fixed it.                                                                                                                                                                                      |
| 3   | Schema migration `0049_dear_killraven.sql` + Drizzle schema                                                                                                       | `mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live','paper'))` on `poly_copy_trade_targets`, `poly_copy_trade_fills`, `poly_copy_trade_decisions`. RLS not touched. Existing rows default to `'live'` — production is unaffected.                                                                                                                                                        |
| 4   | `PaperAdapter` body (`nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts`)                                                                   | Zod-typed loopback HTTP IPC. **No fill logic in this file** — only IPC + delegation. The MIT sidecar (agent-next/polymarket-paper-trader) owns the fill model upstream. Five invariants documented in the file header — `PAPER_DELEGATES_READS_TO_LIVE`, `PAPER_POPULATES_FILLED_USDC`, `PAPER_GETORDER_NEVER_NULL`, `MARKET_PROVIDER_SHAPE_FROZEN`, `PACKAGES_NO_ENV`.                        |
| 5   | Executor dispatcher (`nodes/poly/app/src/bootstrap/capabilities/poly-trade-executor.ts`)                                                                          | The critical seam. Two `ClobExecutor` instances per tenant, dispatch in `authorizedPlace` on `intent.attributes.mode ?? "live"`. `PAPER_ENFORCE_MODE=paper` env override sits at the top of `authorizedPlace`. `cancelOrder` + `getOrder` gain optional `mode` arg, defaulting `"live"` for back-compat. Honors `EXECUTOR_SEAM_IS_PLACE_ORDER_FN` and `PLACEMENT_DISCRIMINATOR_IN_ATTRIBUTES`. |
| 6   | `attributes.mode` stamp — `plan-mirror.ts` `buildIntent()` + `mirror-pipeline.ts` SELL-close intent (line ~901)                                                   | Planner stays pure (`PLANNER_IS_PURE`). `mode` is a 7th argument to `buildIntent`. Pipeline's SELL-close intent reads `deps.target.mode`.                                                                                                                                                                                                                                                      |
| 7   | Bootstrap reads DB `mode` — `dbTargetSource` SELECTs `mode`, threads through `EnumeratedTarget` → `buildMirrorTargetConfig` → planner                             | `copy-trade-mirror.job.ts:243` hardcoded `mode: "live"` is removed. envTargetSource defaults `mode: "live"` to preserve local-dev / test behaviour.                                                                                                                                                                                                                                            |
| 8   | Sidecar Dockerfile + FastAPI placeholder (`infra/images/poly-paper-sidecar/`)                                                                                     | v0 placeholder: `/healthz` returns 200; Run-phase endpoints return 501. **Not added to the base k8s manifest** (would crash production); lands in PR 2's overlay patches. The actual upstream-engine glue is a follow-up commit; this PR establishes the HTTP contract.                                                                                                                        |
| 9   | Tests                                                                                                                                                             | `nodes/poly/packages/market-provider/tests/paper-adapter.test.ts` (6 new) + the rewritten `order-schemas.test.ts` "P1 stub" assertion. `nodes/poly/app/tests/_fakes/paper-adapter.fake.ts` is the in-memory fake for app-side tests (no Python sidecar needed in CI).                                                                                                                          |
| 10  | Spec update — `docs/spec/poly-copy-trade-execution.md` documents `MODE_DISCRIMINATOR_IN_ATTRIBUTES` next to the existing `PLACEMENT_DISCRIMINATOR_IN_ATTRIBUTES`. |

## What to push on

The reviewer should poke at, in priority order:

1. **Is the production-safety claim airtight?** Production has no paper-mode targets, no sidecar container, no `PAPER_ENFORCE_MODE`. The dispatcher's `paperPlace` branch must be unreachable on prod traffic. If you can construct a sequence where production accidentally routes through paper, that's a blocker.
2. **Cap accounting (CAP_COUNTS_REALIZED_ON_CANCEL).** The paper adapter must populate `OrderReceipt.filled_size_usdc` faithfully. The PaperAdapter test covers wire-shape but not partial-fill cap-drift end-to-end. The `FakePaperAdapter` covers it (`FAKE_RETURNS_FILLED_SIZE_USDC`); a missing dispatcher integration test in `nodes/poly/app/tests/unit/` is the gap.
3. **The deferred bits.** See the project doc's "PR 1" table — items 9 (position aggregation paper-awareness) and 10 (paper-redemption job) are deferred to follow-up. The doc is honest about this; the reviewer should confirm the deferral is acceptable given production stays unaffected.

## Known gaps (deferred to follow-up; NOT in PR 1)

- **Paper-redemption job** — paper rows' `position_lifecycle` won't get stamped on market resolution. The existing `features/redeem/` pipeline is funder-scoped and chain-truth-based — it can't see paper positions. A parallel observer needs to watch `ConditionResolution` and stamp `poly_copy_trade_fills WHERE mode='paper'`. Project doc PR 1 table item 10 has the full design.
- **`closePosition` / `exitPosition` paper-awareness** — would error on paper-mode targets (Data API returns no paper positions). Not a deploy blocker for PR 1 — user-facing paper exits don't exist yet.
- **Sidecar Python wrapper** — the FastAPI placeholder ships in this PR; the actual engine glue mapping the HTTP contract to `agent-next/polymarket-paper-trader`'s library is a follow-up commit. Until it lands, paper-mode placements will surface `paper sidecar place-order failed: 501` in Loki — visible signal that the dispatcher reached the sidecar but the engine isn't wired yet.
- **CI image-build pipeline for `ghcr.io/cogni-dao/poly-paper-sidecar`** — PR 2 prereq.

## Smoke test (post-merge, after PR 2 + sidecar wrapper)

1. Provision VMs (in-flight).
2. Merge PR 1.
3. Land the sidecar Python wrapper that maps the HTTP contract to upstream.
4. Build + push the sidecar image.
5. Merge PR 2 (overlay patches).
6. Flip one production target to `mode='paper'` in `poly_copy_trade_targets`.
7. Watch a BUY fire through the dispatcher, hit the sidecar, get a paper receipt, populate `poly_copy_trade_fills` with `mode='paper'`.
8. On market resolution, confirm a paper-redemption stamps `position_lifecycle` (requires the deferred follow-up #10 to be landed).

## CI

Last force-push: `eafdfc978` (post-rebase onto current `origin/main` to resolve a conflict with PR #36's `listPositions` → `listAllUserPositions` pagination change in `poly-trade-executor.ts`). Pre-push hooks pass: `pnpm exec tsc -p tsconfig.app.json --noEmit` clean, full poly-app test sweep 1741 passed / 15 skipped, `pnpm db:check` chain monotonic, `pnpm check:fast` green.

## Open conversation pointers

- The "we write no fill logic" constraint was strict from the user. Shadow-attribution was proposed, rejected because it skips the algorithm. The final shape (algorithm runs end-to-end, only the CLOB call is swapped) is the user's preferred design — don't undo this in review.
- The 96-98% fidelity ceiling is acknowledged. Queue position at congested price levels is the irreducible OSS gap. The only tool that closes it (homerun) is AGPL-3.0, ruled out.
- Limit-orders-only + ride-to-redemption (the strategy constraints) are load-bearing on the fidelity story. If those constraints change, the project's premise must be re-evaluated.
