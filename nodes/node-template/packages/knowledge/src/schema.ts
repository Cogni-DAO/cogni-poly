/**
 * Module: `@cogni/node-template-knowledge/schema`
 * Purpose: Base knowledge table — Drizzle definition, single source of truth.
 * Scope: Drizzle table definitions only. Targets Doltgres (pg wire protocol).
 * Invariants:
 *   - SCHEMA_GENERIC_CONTENT_SPECIFIC: Domain specificity in `domain` column + `tags` JSONB.
 *   - AWARENESS_HOT_KNOWLEDGE_COLD: Separate from awareness tables in Postgres.
 *   - No FK references to Postgres tables (different database server).
 *   - No RLS — access control via Doltgres roles (knowledge_reader / knowledge_writer).
 *   - drizzle-kit generates migrations against this definition; provision.sh
 *     creates the DB + roles only, it does not create tables.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, nodes/poly/app/schema/README.md
 * @public
 */

import { index, jsonb, pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Knowledge — domain-specific facts, claims, and curated assertions with provenance.
 * Generic schema: domain specificity lives in row content, not table structure.
 *
 * This is the base table inherited by all nodes. Nodes may add companion tables
 * for domain-specific extensions via their node-local schema file (e.g.
 * nodes/poly/app/schema/knowledge.ts).
 */
export const knowledge = pgTable(
  "knowledge",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    entityId: text("entity_id"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    confidencePct: integer("confidence_pct"),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref"),
    tags: jsonb("tags").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_knowledge_domain").on(table.domain),
    index("idx_knowledge_entity").on(table.entityId),
    index("idx_knowledge_source_type").on(table.sourceType),
  ],
);
