-- task.5003 (SSoT mode): backfill `poly_copy_trade_{fills,decisions}.mode`
-- on envs where the historical execution path was paper but the column
-- always wrote the schema default `'live'` (the ledger never stamped mode
-- before this PR).
--
-- Self-healing, PROD-safe by construction:
--
--   * Every decision row's `intent` JSONB carries `mode: target.mode`
--     stamped at write time by `mirror-pipeline.ts::buildDecisionIntentBlob`.
--   * On cand-a + preview, `MirrorTargetConfig.mode` is `'paper'` because
--     `container.ts` derives it from `PAPER_ENFORCE_MODE=paper`, so those
--     blobs read `intent->>'mode' = 'paper'`.
--   * On PROD, `PAPER_ENFORCE_MODE` is unset, so every stored blob reads
--     `'live'` and these UPDATEs are no-ops.
--
-- Idempotent: the `mode = 'live'` guard means a re-run cannot flip a
-- correctly-stamped row.

UPDATE poly_copy_trade_decisions
   SET mode = 'paper'
 WHERE mode = 'live'
   AND intent->>'mode' = 'paper';
--> statement-breakpoint

-- Fills don't carry `mode` in their own JSONB (`order-ledger.ts::insertPending`
-- never extracted it from intent.attributes), so we join to decisions on the
-- composite key `(billing_account_id, target_id, fill_id)` — the same PK
-- triple both tables share via `RECORD_EVERY_DECISION`. Any fill paired with
-- a paper-stamped decision was itself produced by a paper-routed placement.
UPDATE poly_copy_trade_fills f
   SET mode = 'paper'
  FROM poly_copy_trade_decisions d
 WHERE f.mode = 'live'
   AND d.billing_account_id = f.billing_account_id
   AND d.target_id = f.target_id
   AND d.fill_id = f.fill_id
   AND d.intent->>'mode' = 'paper';
