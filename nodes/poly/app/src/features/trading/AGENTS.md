# trading · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Generic Polymarket placement + order-ledger substrate. Every path that places an order on behalf of the operator wallet routes through this layer: the agent-callable `core__poly_place_trade` tool, the autonomous mirror-coordinator, and the future P4 WS ingester. Survives every phase — not scaffolding, not copy-trade-specific.

## Pointers

- [task.0315 — Phase 1 plan](../../../../../../work/items/task.0315.poly-copy-trade-prototype.md)
- [Phase 1 spec](../../../../../../docs/spec/poly-copy-trade-execution.md)
- [Root poly node AGENTS.md](../AGENTS.md)
- Sibling layers: [../copy-trade/AGENTS.md](../copy-trade/AGENTS.md), [../wallet-watch/AGENTS.md](../wallet-watch/AGENTS.md)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["features", "ports", "core", "shared", "types"],
  "must_not_import": [
    "app",
    "adapters/server",
    "adapters/worker",
    "bootstrap",
    "contracts"
  ]
}
```

`trading/` is intentionally siloed from `copy-trade/` and `wallet-watch/` — it does not know what calls it. The `copy-trade/mirror-coordinator` imports `trading/`, never the reverse. The `features/copy-trade` + `features/wallet-watch` no-import rule is enforced by review + the `TRADING_IS_GENERIC` invariant below; the AGENTS.md validator only models coarse layers.

## Public Surface

- **Exports (executor):** `createClobExecutor(deps) → ClobExecutor`, `ClobExecutorDeps`, `CLOB_EXECUTOR_METRICS`.
- **Exports (order ledger root):** `createOrderLedger(deps) → OrderLedger`, `OrderLedgerDeps`, `forTenant(ctx: TenantContext) → TenantOrderLedger`, `findStaleOpen` (cross-tenant TTL sweeper, the only sanctioned cross-tenant read).
- **Exports (tenant-scoped ledger):** `TenantOrderLedger` — closes over the `TenantContext` and exposes every per-tenant op with no tenant args: `snapshotState()`, `cumulativeIntentForMarketToken(market_id, token_id)`, `insertPending` (throws `AlreadyRestingError` on partial-unique-index conflict), `markOrderId`, `markError`, `markCanceled` (typed `LedgerCancelReason`), `updateStatus`, `recordDecision`, `listRecent`, `listTenantPositions`, `listOpenOrPending`, `hasOpenForMarket`, `findOpenForMarket`, `markSynced`, `markPositionClosedByAsset`, `markPositionLifecycleByAsset`, `markPositionLifecycleByConditionId`, `syncHealthSummary`.
- **Exports (types):** `TenantContext` (`{billing_account_id, created_by_user_id, target_id}` — the envelope every tenant-scoped op closes over), `LedgerRow` (includes `synced_at` + `position_lifecycle`), `LedgerStatus`, `LedgerPositionLifecycle`, `StateSnapshot` (carries `position_aggregates: PositionIntentAggregate[]`), `PositionIntentAggregate` (generic per-(market_id, token_id) intent aggregate — vocabulary stays inside trading, mirror semantics overlay lives in `@/features/copy-trade`), `UpdateStatusInput`, `ListOpenOrPendingOptions`, `SyncHealthSummary`, `OpenOrderRow`, `LedgerCancelReason`, `AlreadyRestingError`.

## Invariants

- **TRADING_IS_GENERIC** — files in this slice MUST NOT import `features/copy-trade/` or `features/wallet-watch/`. Vocabulary is "order," "intent," "receipt," "ledger." Never "target," "mirror," "fill-observation."
- **EXECUTOR_SEAM_IS_PLACE_ORDER_FN** — the executor takes a `placeOrder(intent) => receipt` function, not an adapter instance. Mock seam for tests + future WS consumer.
- **NO_STATIC_CLOB_IMPORT** — no static import of `@polymarket/clob-client` or `@privy-io/node`. Only `bootstrap/capabilities/poly-trade.ts::buildRealAdapterMethods` dynamically imports those.
- **INSERT_BEFORE_PLACE** _(order-ledger consumers)_ — callers that use the ledger with the mirror-coordinator MUST call `insertPending` before `placeIntent` and `markOrderId` after. The ledger itself is ordering-agnostic; the invariant is the coordinator's responsibility.
- **TENANT_SCOPED_OPS_REQUIRE_CTX** _(bug.5022)_ — every method that reads/writes tenant-scoped rows lives on `TenantOrderLedger`, reachable only via `OrderLedger.forTenant(ctx: TenantContext)`. Calling a tenant-scoped op directly on the root `OrderLedger` is a type error. New algorithms automatically inherit tenant isolation.
- **WITH_TENANT_SCOPE_WRAPS_EVERY_TENANT_READ** _(bug.5022)_ — every method on `TenantOrderLedger` opens `withTenantScope(appDb, ctx.created_by_user_id, ...)`. RLS on `poly_copy_trade_{fills,decisions}` (keyed on `created_by_user_id`) is the runtime backstop; even a missing `.where()` clause cannot leak cross-tenant rows.
- **APP_DB_FOR_TENANT_DATA** _(bug.5022)_ — the order ledger is constructed against `appDb` (RLS-eligible `app_user` role), NOT `serviceDb`. The historical "BYPASSRLS is fine because these tables are system-owned" stance regressed cross-tenant isolation and is rejected.
- **EXPLICIT_BILLING_ACCOUNT_ID_DEFENSE_IN_DEPTH** _(bug.5022)_ — queries inside `TenantOrderLedger` keep `eq(billingAccountId, ctx.billing_account_id)` even though RLS would already filter. Self-documenting SQL + forward-compatible with a future "one user owns multiple billing accounts" model.
- **CROSS_TENANT_OPS_NAMED_EXPLICITLY** _(bug.5022)_ — only `findStaleOpen` (TTL sweeper) is cross-tenant; documented as such on the root `OrderLedger`. New cross-tenant ops require an explicit design callout in `docs/spec/poly-tenant-and-collateral.md`.
- **CAP_COUNTS_REALIZED_ON_CANCEL** _(bug.5050)_ — `cumulativeIntentForMarketToken` counts `canceled` rows by their `filled_size_usdc` (or `size_usdc` if not populated). A STALE_RESTING_CANCEL_REPLACE on a partially-filled order leaves the realized shares in our wallet past the order's terminal state; the cap must reflect that exposure or follow-on placements leak past `max_market_intent_usdc`. The SQL CASE in `order-ledger.ts` and the helper `ledgerCountedIntentUsdc` in `ledger-lifecycle.ts` MUST stay in sync. Per `CAP_IS_PER_TOKEN_ID` (bug.5004) the sum is also scoped to `attributes->>'token_id'`.
- **BOUNDED_METRIC_RESULT** — the executor's `result` label is one of `{ok, rejected, error}`.

## Responsibilities

- Own the Polymarket CLOB executor (structured logs + metrics wrapper around an injected `placeOrder`).
- Own the order-ledger read/write surface over `poly_copy_trade_fills` + `poly_copy_trade_decisions` (table rename deferred to P2).
- Expose `forTenant(ctx).snapshotState()` returning `StateSnapshot` data so the coordinator doesn't SELECT directly. The compiler enforces that callers construct a `TenantContext` first; `withTenantScope(appDb, ctx.created_by_user_id, ...)` activates RLS at the DB layer. (bug.0438 dropped the kill-switch read; only cap counters + dedup keys remain.)

## Notes

- **DB client:** uses `appDb` (RLS-enforced `app_user` role) from the bootstrap container — NOT `serviceDb`. Tenant-scoped methods wrap their queries in `withTenantScope(appDb, ctx.created_by_user_id, ...)` so Postgres RLS policies on `poly_copy_trade_{fills,decisions}` (keyed on `created_by_user_id`) become the structural floor for tenant isolation. See `APP_DB_FOR_TENANT_DATA` invariant. The cross-tenant `findStaleOpen` TTL sweeper is the only sanctioned `serviceDb` (BYPASSRLS) reader.
- **Single-tenant boundary:** the executor doesn't know about wallets or tenants — the `placeOrder` seam is passed in by `bootstrap/capabilities/poly-trade.ts` which holds the `HARDCODED_WALLET_SECRETS_OK` isolation.
- **Extension points:** adding SELL support, adding a paper adapter route, or adding a cancel-order executor all live here. Adding multi-tenant wallet-keyed placement is a `bootstrap/` concern, not a trading-layer concern. **New tenant-scoped reads or writes MUST go on `TenantOrderLedger`, never the root.**
