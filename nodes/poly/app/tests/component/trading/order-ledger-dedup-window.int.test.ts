// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/trading/order-ledger-dedup-window.int`
 * Purpose: bug.5023 regression — prove that `snapshotState.{already_placed_ids,
 *          placed_fill_ids}` is bounded by `SNAPSHOT_DEDUP_WINDOW_DAYS`.
 *          Pre-bug.5023 the query was unbounded; a single high-placement
 *          tenant accumulated 2,748+ fills and gunked the Node event loop on
 *          every chain event (OOM ~10–20h on Tier-0).
 * Scope: One tenant, one target. Seed fills with explicit `created_at` values
 *        spanning inside and outside the window. Assert the snapshot returns
 *        only in-window COIDs/fill_ids.
 * Invariants tested:
 *   - DEDUP_WINDOW_IS_BOUNDED — outside-window fills do not appear in the
 *     `already_placed_ids` / `placed_fill_ids` arrays.
 *   - The PK `(target_id, fill_id)` backstop on `insertPending` remains the
 *     correctness anchor; this test does NOT prove that backstop, only that
 *     the read side is bounded.
 * Side-effects: writes 1 user + 1 billing account + 1 target + N fills.
 *               Tears down via `billing_accounts CASCADE`.
 * Links: work/items/bug.5023.md, src/features/trading/order-ledger.ts
 *        (DEDUP_WINDOW_IS_BOUNDED invariant)
 * @public
 */

import { randomUUID } from "node:crypto";
import {
  polyCopyTradeFills,
  polyCopyTradeTargets,
} from "@cogni/poly-db-schema";
import { noopLogger } from "@cogni/poly-market-provider";
import {
  generateTestWallet,
  seedAuthenticatedUser,
} from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAppDb } from "@/adapters/server/db/client";
import {
  createOrderLedger,
  type OrderLedger,
  SNAPSHOT_DEDUP_WINDOW_DAYS,
} from "@/features/trading";

const MARKET_ID = `prediction-market:polymarket:0xbug5023-${"0".repeat(56)}`;
const TOKEN_ID =
  "20000000000000000000000000000000000000000000000000000000000000023";

interface Tenant {
  userId: string;
  billingAccountId: string;
  targetId: string;
}

async function seedTenant(label: string): Promise<Tenant> {
  const seeded = await seedAuthenticatedUser(getSeedDb(), {
    id: randomUUID(),
    walletAddress: generateTestWallet(`bug5023-${label}`),
    name: `bug5023-${label}`,
  });
  const [target] = await getSeedDb()
    .insert(polyCopyTradeTargets)
    .values({
      id: randomUUID(),
      billingAccountId: seeded.billingAccount.id,
      createdByUserId: seeded.user.id,
      targetWallet: generateTestWallet(`bug5023-tgt-${label}`).toLowerCase(),
    })
    .returning({ id: polyCopyTradeTargets.id });
  if (!target?.id) throw new Error("failed to seed target");
  return {
    userId: seeded.user.id,
    billingAccountId: seeded.billingAccount.id,
    targetId: target.id,
  };
}

async function seedFillAtAge(
  t: Tenant,
  opts: { ageDays: number; label: string }
): Promise<{ fillId: string; coid: string }> {
  const fillId = `data-api:${opts.label}-${randomUUID()}`;
  const coid = `0x${randomUUID().replace(/-/g, "")}`;
  const createdAt = new Date(Date.now() - opts.ageDays * 86_400_000);
  await getSeedDb()
    .insert(polyCopyTradeFills)
    .values({
      billingAccountId: t.billingAccountId,
      createdByUserId: t.userId,
      targetId: t.targetId,
      fillId,
      marketId: MARKET_ID,
      observedAt: createdAt,
      createdAt,
      // `updated_at` defaults to now() but Drizzle's schema allows override.
      updatedAt: createdAt,
      clientOrderId: coid,
      orderId: null,
      status: "filled",
      attributes: {
        market_id: MARKET_ID,
        token_id: TOKEN_ID,
        side: "BUY",
        size_usdc: 1,
        limit_price: 0.5,
      },
    });
  return { fillId, coid };
}

describe("order-ledger snapshotState dedup window — bug.5023 regression (component)", () => {
  let tenant: Tenant;
  let ledger: OrderLedger;

  beforeEach(async () => {
    tenant = await seedTenant("primary");
    ledger = createOrderLedger({
      db: getSeedDb() as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase,
      appDb: getAppDb(),
      logger: noopLogger,
    });
  });

  afterEach(async () => {
    const { billingAccounts, users } = await import("@/shared/db/schema");
    const { eq } = await import("drizzle-orm");
    await getSeedDb()
      .delete(billingAccounts)
      .where(eq(billingAccounts.id, tenant.billingAccountId));
    await getSeedDb().delete(users).where(eq(users.id, tenant.userId));
  });

  it("returns COIDs and fill_ids from fills within the dedup window", async () => {
    const recent1 = await seedFillAtAge(tenant, {
      ageDays: 0,
      label: "recent1",
    });
    const recent2 = await seedFillAtAge(tenant, {
      ageDays: 1,
      label: "recent2",
    });

    const snap = await ledger.snapshotState(
      tenant.targetId,
      tenant.billingAccountId
    );

    expect(snap.already_placed_ids).toEqual(
      expect.arrayContaining([recent1.coid, recent2.coid])
    );
    expect(snap.placed_fill_ids).toEqual(
      expect.arrayContaining([recent1.fillId, recent2.fillId])
    );
    expect(snap.already_placed_ids).toHaveLength(2);
    expect(snap.placed_fill_ids).toHaveLength(2);
  });

  it("excludes COIDs and fill_ids from fills older than SNAPSHOT_DEDUP_WINDOW_DAYS", async () => {
    const inWindow = await seedFillAtAge(tenant, {
      ageDays: SNAPSHOT_DEDUP_WINDOW_DAYS - 1,
      label: "in-window",
    });
    const justOutside = await seedFillAtAge(tenant, {
      ageDays: SNAPSHOT_DEDUP_WINDOW_DAYS + 1,
      label: "just-outside",
    });
    const ancient = await seedFillAtAge(tenant, {
      ageDays: 90,
      label: "ancient",
    });

    const snap = await ledger.snapshotState(
      tenant.targetId,
      tenant.billingAccountId
    );

    expect(snap.already_placed_ids).toEqual([inWindow.coid]);
    expect(snap.placed_fill_ids).toEqual([inWindow.fillId]);
    expect(snap.already_placed_ids).not.toContain(justOutside.coid);
    expect(snap.already_placed_ids).not.toContain(ancient.coid);
    expect(snap.placed_fill_ids).not.toContain(justOutside.fillId);
    expect(snap.placed_fill_ids).not.toContain(ancient.fillId);
  });

  it("forTenant(ctx).snapshotState() applies the same window bound — back-compat", async () => {
    const inWindow = await seedFillAtAge(tenant, {
      ageDays: 0,
      label: "for-tenant-in",
    });
    await seedFillAtAge(tenant, {
      ageDays: SNAPSHOT_DEDUP_WINDOW_DAYS + 5,
      label: "for-tenant-out",
    });

    const snap = await ledger
      .forTenant({
        billing_account_id: tenant.billingAccountId,
        created_by_user_id: tenant.userId,
      })
      .snapshotState(tenant.targetId);

    expect(snap.already_placed_ids).toEqual([inWindow.coid]);
    expect(snap.placed_fill_ids).toEqual([inWindow.fillId]);
  });
});
