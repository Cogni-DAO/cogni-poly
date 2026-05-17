// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/copy-trade/multi-tenant-fills-pk.int`
 * Purpose: Proves the multi-tenant fix to `poly_copy_trade_fills.PK` —
 *          two tenants mirroring the SAME (target_id, fill_id) BOTH get a
 *          DB row inserted (no `ON CONFLICT DO NOTHING` swallow). Closes
 *          the data-layer bug surfaced during PR #63's tenant-scope
 *          validation: validator-A and validator-B each produced 3
 *          `place.tenant` events but only 1 row each in DB because the
 *          composite PK was `(target_id, fill_id)` — billing_account_id
 *          was not in the conflict key.
 * Scope: OrderLedger layer. Uses the real `createOrderLedger` against
 *        testcontainers Postgres. No HTTP, no executor.
 * Invariants tested:
 *   - INTER_TENANT_INDEPENDENCE: insertPending from tenant A + tenant B with
 *     identical (target_id, fill_id) ⇒ 2 rows.
 *   - PER_TENANT_IDEMPOTENCY: insertPending from tenant A twice for the same
 *     (target_id, fill_id) ⇒ 1 row (silent no-op on conflict).
 *   - CLIENT_ORDER_ID_DIFFERS_ACROSS_TENANTS: `clientOrderIdFor` returns
 *     distinct hashes for the same (target, fill) under different tenants,
 *     so CLOB-side placements never share an idempotency key.
 * Side-effects: writes 2 users + 2 billing accounts + 2 targets + 1–2 fills.
 * Links: src/features/trading/order-ledger.ts (insertPending),
 *   packages/db-schema/src/copy-trade.ts (PK),
 *   packages/market-provider/src/domain/client-order-id.ts (helper)
 * @public
 */

import { randomUUID } from "node:crypto";
import {
  polyCopyTradeFills,
  polyCopyTradeTargets,
} from "@cogni/poly-db-schema";
import { clientOrderIdFor } from "@cogni/poly-market-provider";
import {
  generateTestWallet,
  seedAuthenticatedUser,
} from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContainer } from "@/bootstrap/container";
import type { InsertPendingInput } from "@/features/trading/order-ledger.types";

interface TenantFixture {
  userId: string;
  billingAccountId: string;
}

async function seedTenant(label: string): Promise<TenantFixture> {
  const seeded = await seedAuthenticatedUser(getSeedDb(), {
    id: randomUUID(),
    walletAddress: generateTestWallet(`multi-tenant-pk-${label}`),
    name: `Multi-Tenant PK ${label}`,
  });
  return {
    userId: seeded.user.id,
    billingAccountId: seeded.billingAccount.id,
  };
}

// Both tenants intentionally target the SAME wallet — that's how the legacy
// PK collision manifested. The actual `target_id` they share is the uuidv5
// of this wallet; in production the planner derives it via
// `targetIdFromWallet`. Here we pick any deterministic uuid that two tenants
// could plausibly land on.
const SHARED_TARGET_ID = "473e0467-8257-583e-ac93-dea278662cb2";
const SHARED_FILL_ID = "data-api:0xshared:0xasset:BUY:1713302400";
const SHARED_MARKET_ID =
  "prediction-market:polymarket:0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead";

function buildInsertInput(
  tenant: TenantFixture,
  client_order_id: `0x${string}`,
  fill_id = SHARED_FILL_ID
): InsertPendingInput {
  return {
    target_id: SHARED_TARGET_ID,
    fill_id,
    billing_account_id: tenant.billingAccountId,
    created_by_user_id: tenant.userId,
    observed_at: new Date(),
    intent: {
      provider: "polymarket",
      market_id: SHARED_MARKET_ID,
      outcome: "YES",
      side: "BUY",
      size_usdc: 1,
      limit_price: 0.5,
      client_order_id,
    },
  };
}

describe("poly_copy_trade_fills multi-tenant PK (component)", () => {
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeEach(async () => {
    tenantA = await seedTenant("a");
    tenantB = await seedTenant("b");
    // Each tenant also needs an active target row so the FK / cap-related
    // queries in the ledger don't trip. The PK fix is on `fills`, but the
    // ledger writes both via `insertPending` (fills) and `recordDecision`
    // (decisions). Targets here are seeded as system data; we don't go
    // through the per-user route.
    await getSeedDb()
      .insert(polyCopyTradeTargets)
      .values([
        {
          billingAccountId: tenantA.billingAccountId,
          createdByUserId: tenantA.userId,
          targetWallet: "0x204f72f35326db932158cba6adff0b9a1da95e14",
        },
        {
          billingAccountId: tenantB.billingAccountId,
          createdByUserId: tenantB.userId,
          targetWallet: "0x204f72f35326db932158cba6adff0b9a1da95e14",
        },
      ]);
  });

  afterEach(async () => {
    const { billingAccounts, users } = await import("@/shared/db/schema");
    // Clean any rows we wrote for the shared (target_id, fill_id) pair across
    // both tenants — billing_accounts CASCADE will catch most, but we also
    // delete fills directly in case any seed step left noise.
    await getSeedDb()
      .delete(polyCopyTradeFills)
      .where(eq(polyCopyTradeFills.targetId, SHARED_TARGET_ID));
    const ids = [tenantA.billingAccountId, tenantB.billingAccountId];
    const userIds = [tenantA.userId, tenantB.userId];
    await getSeedDb()
      .delete(billingAccounts)
      .where(inArray(billingAccounts.id, ids));
    await getSeedDb().delete(users).where(inArray(users.id, userIds));
  });

  it("INTER_TENANT_INDEPENDENCE — both tenants insertPending(same target, same fill) ⇒ 2 rows", async () => {
    // Compute the new-shape client_order_ids — distinct because they include
    // billing_account_id. This is the property a future regression would
    // silently violate.
    const coidA = clientOrderIdFor(
      tenantA.billingAccountId,
      SHARED_TARGET_ID,
      SHARED_FILL_ID
    );
    const coidB = clientOrderIdFor(
      tenantB.billingAccountId,
      SHARED_TARGET_ID,
      SHARED_FILL_ID
    );
    expect(coidA).not.toBe(coidB);

    await getContainer().orderLedger.insertPending(
      buildInsertInput(tenantA, coidA)
    );
    await getContainer().orderLedger.insertPending(
      buildInsertInput(tenantB, coidB)
    );

    const rows = await getSeedDb()
      .select({
        billingAccountId: polyCopyTradeFills.billingAccountId,
        clientOrderId: polyCopyTradeFills.clientOrderId,
        status: polyCopyTradeFills.status,
      })
      .from(polyCopyTradeFills)
      .where(
        and(
          eq(polyCopyTradeFills.targetId, SHARED_TARGET_ID),
          eq(polyCopyTradeFills.fillId, SHARED_FILL_ID)
        )
      )
      .orderBy(polyCopyTradeFills.billingAccountId);

    expect(rows).toHaveLength(2);
    const billingIds = rows.map((r) => r.billingAccountId).sort();
    expect(billingIds).toEqual(
      [tenantA.billingAccountId, tenantB.billingAccountId].sort()
    );
    const coids = rows.map((r) => r.clientOrderId);
    expect(new Set(coids).size).toBe(2);
    expect(coids).toEqual(expect.arrayContaining([coidA, coidB]));
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("PER_TENANT_IDEMPOTENCY — tenant A insertPending twice for same (target, fill) ⇒ 1 row", async () => {
    const coidA = clientOrderIdFor(
      tenantA.billingAccountId,
      SHARED_TARGET_ID,
      SHARED_FILL_ID
    );
    await getContainer().orderLedger.insertPending(
      buildInsertInput(tenantA, coidA)
    );
    // Second call is the intra-tenant retry path. ON CONFLICT (billing, target,
    // fill) DO NOTHING ⇒ silent no-op. The mirror coordinator's
    // INSERT_BEFORE_PLACE invariant relies on this — re-runs must not raise.
    await getContainer().orderLedger.insertPending(
      buildInsertInput(tenantA, coidA)
    );

    const rows = await getSeedDb()
      .select({ id: polyCopyTradeFills.targetId })
      .from(polyCopyTradeFills)
      .where(
        and(
          eq(polyCopyTradeFills.billingAccountId, tenantA.billingAccountId),
          eq(polyCopyTradeFills.targetId, SHARED_TARGET_ID),
          eq(polyCopyTradeFills.fillId, SHARED_FILL_ID)
        )
      );
    expect(rows).toHaveLength(1);
  });
});
