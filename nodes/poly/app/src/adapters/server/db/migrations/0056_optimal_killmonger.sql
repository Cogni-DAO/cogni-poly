-- bug.5018 — first-class realized-fill columns on the mirror ledger.
-- price/shares/fees_usdc precision matches `poly_trader_fills` so PnL/VWAP
-- aggregation queries don't lose precision when joining target-side and
-- mirror-side. Forward-only: pre-deploy paper rows leave these NULL; the
-- tenant-matrix-evaluator filters paper rows by `WHERE price IS NOT NULL`
-- to discriminate post-deploy fills from the legacy intent-padded snapshot.
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "price" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "shares" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "fees_usdc" numeric(20, 8);--> statement-breakpoint
-- PnL/VWAP covering index. CONCURRENTLY because `poly_copy_trade_fills` is
-- populated in prod and a plain `CREATE INDEX` would take ACCESS EXCLUSIVE
-- on the table, blocking the mirror-pipeline write path until completion.
-- INCLUDE columns let `SUM(price*shares)/SUM(shares)` aggregations run as
-- index-only scans (no heap fetch). Hand-authored because drizzle-kit
-- emits neither `CONCURRENTLY` nor `INCLUDE` from its index DSL.
--
-- CONCURRENTLY note: PG forbids CONCURRENTLY inside a transaction; this
-- statement-breakpoint is intentional — the migrator runs each statement
-- in its own transaction. IF NOT EXISTS makes the migration idempotent
-- across reruns (CONCURRENTLY leaves an INVALID index behind on failure,
-- which a follow-up retry can drop + recreate manually).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "poly_copy_trade_fills_pnl_idx" ON "poly_copy_trade_fills" USING btree ("billing_account_id","target_id","market_id","mode","status") INCLUDE ("price","shares","fees_usdc");