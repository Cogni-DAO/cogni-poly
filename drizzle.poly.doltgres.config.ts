// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `drizzle.poly.doltgres.config`
 * Purpose: drizzle-kit config for poly's Doltgres knowledge schema (`knowledge_poly`).
 *   Mirrors the per-node drizzle config pattern (drizzle.poly.config.ts for
 *   poly's Postgres tables). Targets Doltgres via pg wire protocol.
 * Invariants:
 *   - Single source of truth for the table shape is nodes/poly/app/schema/knowledge.ts.
 *   - Migration output is checked into the repo so the VM migrator can run pure SQL
 *     (no Node toolchain on the VM).
 *   - DOLTGRES_URL_POLY names the specific DB (…/knowledge_poly). The URL is only
 *     consulted by the migrator at apply-time; generation doesn't require a live DB.
 * Side-effects: IO during migration generation (writes SQL files).
 * Links: nodes/poly/app/schema/README.md, docs/spec/knowledge-data-plane.md
 * @public
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./nodes/poly/app/schema/knowledge.ts",
  out: "./nodes/poly/app/src/adapters/server/db/doltgres-migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DOLTGRES_URL_POLY ??
      "postgresql://postgres:doltgres@localhost:5435/knowledge_poly",
  },
  verbose: true,
  strict: true,
});
