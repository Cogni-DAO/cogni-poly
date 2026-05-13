// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/doltgres/client`
 * Purpose: Lazy poly-Doltgres `Sql` singleton + adapter wiring for the work_items API (task.5044).
 * Scope: Builds a postgres.js client and a `DoltgresPolyWorkItemAdapter`. Mirrors the operator's adapter shape so per-node and central views stay symmetrical.
 * Invariants: Single connection per process; lazy initialization; throws `DoltgresNotConfiguredError` when `DOLTGRES_URL_POLY` is unset.
 * Side-effects: IO (database connection on first access).
 * Links: docs/spec/work-items-port.md
 * @internal
 */

import { buildDoltgresClient } from "@cogni/knowledge-store/adapters/doltgres";
import type { Sql } from "postgres";

import { serverEnv } from "@/shared/env/server-env";

import { DoltgresPolyWorkItemAdapter } from "./work-items-adapter";

export class DoltgresNotConfiguredError extends Error {
  constructor() {
    super(
      "Doltgres is not configured for this runtime. Set DOLTGRES_URL_POLY to enable the poly work-items API."
    );
    this.name = "DoltgresNotConfiguredError";
  }
}

let _sql: Sql | null = null;
let _adapter: DoltgresPolyWorkItemAdapter | null = null;

function createSql(): Sql {
  const env = serverEnv();
  if (!env.DOLTGRES_URL_POLY) {
    throw new DoltgresNotConfiguredError();
  }
  return buildDoltgresClient({
    connectionString: env.DOLTGRES_URL_POLY,
    applicationName: `cogni_work_items_${env.SERVICE_NAME ?? "app"}`,
  });
}

export function getDoltgresSql(): Sql {
  if (!_sql) _sql = createSql();
  return _sql;
}

export function getDoltgresWorkItemsAdapter(): DoltgresPolyWorkItemAdapter {
  if (!_adapter) _adapter = new DoltgresPolyWorkItemAdapter(getDoltgresSql());
  return _adapter;
}
