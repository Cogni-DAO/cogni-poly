// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `nodes/poly/app/schema/knowledge`
 * Purpose: Poly node's Doltgres knowledge schema entry point for drizzle-kit.
 *   Re-exports the base `knowledge` table from `@cogni/node-template-knowledge`
 *   plus any poly-specific companion tables added over time.
 * Scope: Schema definitions only. No I/O. drizzle-kit discovers this file via
 *   `drizzle.poly.doltgres.config.ts` and generates migrations from it.
 * Invariants:
 *   - Targets Doltgres (not Postgres). Dialect: postgresql (wire-compatible).
 *   - DB_PER_NODE: this schema applies to `knowledge_poly` only. Operator and
 *     resy have their own analogous schema entry points once they land.
 *   - SCHEMA_GENERIC_CONTENT_SPECIFIC: poly-specific content goes in rows
 *     (domain + tags), not new columns. Add companion tables here only when
 *     a genuinely new entity is required.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/multi-node-tenancy.md
 * @public
 */

// Base knowledge table — inherited from node-template, identical across nodes
// until schema divergence is needed. Safe re-export; the Drizzle table object
// is the same instance across all nodes' schema entry points.
export { knowledge } from "@cogni/node-template-knowledge";

// Poly-specific companion tables go here as they're needed, e.g.:
// export const polyMarketCategories = pgTable("poly_market_categories", { ... });
