-- SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
-- SPDX-FileCopyrightText: 2025 Cogni-DAO
--
-- Poly knowledge seeds (v0) — protocol facts only.
--
-- Run by the doltgres-seed-poly compose service against knowledge_poly.
-- Idempotent: ON CONFLICT DO NOTHING means re-runs are safe and cheap.
-- Requires the knowledge table to exist (created by the drizzle-kit migrator).
--
-- Rationale: a knowledge store seeded with AI-authored strategy prose pollutes
-- retrieval. Only externally-verifiable protocol facts seed here. The brain
-- accumulates everything else via its own research + promotion loop.
--
-- See: task.0311, nodes/poly/packages/knowledge/src/seeds/poly.ts (TS source),
--      nodes/poly/app/schema/README.md (migrator pattern)

INSERT INTO knowledge (id, domain, title, content, source_type, source_ref, confidence_pct, tags)
VALUES
  (
    'pm:protocol:clob-mechanics',
    'prediction-market',
    'Polymarket uses a hybrid CLOB on Polygon with USDC settlement',
    'Polymarket''s Central Limit Order Book operates via a custom exchange contract on Polygon. Positions are denominated in USDC. Shares are binary CTF (Conditional Token Framework) tokens — YES and NO shares for each market. A YES+NO pair always resolves to $1.00. Trades settle on-chain; the order book is off-chain (operator-hosted matching engine). Limit orders are free to place; market orders pay taker fees. The Gamma API (REST) and CLOB API (WebSocket) provide market data and order book depth.',
    'external',
    'https://docs.polymarket.com',
    80,
    '["protocol", "clob", "polygon", "usdc"]'::jsonb
  ),
  (
    'pm:protocol:kelly-formula',
    'prediction-market',
    'Kelly criterion — canonical position-sizing formula',
    'Kelly formula: f* = (bp - q) / b, where b = net odds (payout/risk - 1), p = estimated true probability, q = 1 - p. f* is the fraction of bankroll that maximises expected log-growth. Full-Kelly is the theoretical optimum; practitioners use fractional Kelly (half or quarter) to account for estimation error. This entry is a formula reference only — whether and how to apply Kelly in any specific market is a modelling judgment, not encoded here.',
    'external',
    'https://en.wikipedia.org/wiki/Kelly_criterion',
    80,
    '["protocol", "sizing", "reference"]'::jsonb
  ),
  (
    'pm:protocol:hf-datasets',
    'prediction-market',
    'Polymarket on-chain history available as HuggingFace datasets',
    'Pre-built datasets for bulk / historical analysis: SII-WANGZJ/Polymarket_data (full on-chain history, ~107GB), CK0607/polymarket_10000 (market summaries), AiYa1729/polymarket-transactions (transaction-level). For live snapshots use the Gamma API (REST) and CLOB API (WebSocket). Prefer these datasets over scraping — scraping is rate-limited and duplicates work already done.',
    'external',
    'https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data',
    80,
    '["protocol", "data-sources", "datasets"]'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

-- Capture the seed inserts as a Dolt commit. With @@dolt_transaction_commit=1
-- INSERTs auto-commit individually, but we explicitly stamp a named commit for
-- auditability in `dolt_log`.
SELECT dolt_commit('-Am', 'seed: poly protocol facts v0') FROM (SELECT 1) AS _;
