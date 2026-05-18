ALTER TABLE "poly_copy_trade_targets" DROP CONSTRAINT "poly_copy_trade_targets_target_scale_range";--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN "mirror_capital_alloc_usdc" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" DROP COLUMN "target_scale";--> statement-breakpoint
-- 2026-05-18 locked design: position_gap rows MUST carry an explicit alloc.
-- Backfill the three in-flight position_gap tenants (cand-a/RN1-GAP,
-- cand-a/GAP, preview/swiss-gap, plus any others that may have been added
-- after this commit hit main) with $5.00 — matches the existing
-- mirror_max_usdc_per_trade default on those rows. Operators PATCH per-target
-- post-migration to their preferred alloc. Runs BEFORE the requires_alloc
-- CHECK below so the CHECK never sees a violating row.
UPDATE "poly_copy_trade_targets"
SET "mirror_capital_alloc_usdc" = 5.00
WHERE "sizing_policy_kind" = 'position_gap'
  AND "mirror_capital_alloc_usdc" IS NULL;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD CONSTRAINT "poly_copy_trade_targets_capital_alloc_positive" CHECK ("poly_copy_trade_targets"."mirror_capital_alloc_usdc" IS NULL OR "poly_copy_trade_targets"."mirror_capital_alloc_usdc" > 0);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD CONSTRAINT "poly_copy_trade_targets_position_gap_requires_alloc" CHECK ("poly_copy_trade_targets"."sizing_policy_kind" <> 'position_gap' OR "poly_copy_trade_targets"."mirror_capital_alloc_usdc" IS NOT NULL);