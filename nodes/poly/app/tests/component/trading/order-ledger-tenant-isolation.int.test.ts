// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/trading/order-ledger-tenant-isolation.int`
 * Purpose: bug.5022 regression — prove that the Drizzle `OrderLedger.snapshotState`
 *          and `OrderLedger.forTenant(ctx).snapshotState()` paths BOTH filter by
 *          `(billing_account_id, target_id)` and not by `target_id` alone.
 *          Pre-fix, two tenants sharing a `target_wallet` saw each other's
 *          `position_aggregates`, `today_spent_usdc`, `fills_last_hour`, and
 *          `placed_fill_ids` as their own, blocking sub-scale `position_gap`
 *          allocations from ever placing (preview swiss-gap $1k = 0 placements).
 * Scope: Two tenants, same target_wallet → two distinct `(billing_account_id,
 *          target_id)` rows in `poly_copy_trade_targets`. Seed N fills under
 *          each, then assert each tenant's snapshot is independent.
 * Invariants tested:
 *   - TENANT_FILTER_IN_EVERY_SNAPSHOT_QUERY — all four `snapshotState`
 *     queries filter on `billingAccountId` AND `targetId`.
 *   - The `OrderLedger.forTenant(ctx)` factory closes over the tenant and
 *     produces snapshot state structurally identical to the legacy two-arg
 *     `snapshotState(target_id, billing_account_id)` form (back-compat).
 *   - `position_aggregates` are independent across tenants — was the leak
 *     surface in the field (followup_not_needed loop on swiss-gap).
 * Side-effects: writes 2 users + 2 billing accounts + 2 targets + N fills.
 *               Tears down via `billing_accounts CASCADE`.
 * Links: work/items/bug.5022.md, docs/spec/poly-tenant-and-collateral.md
 *        (ORDER_LEDGER_TENANT_CONTEXT_ENVELOPE),
 *        src/features/trading/order-ledger.ts (TENANT_FILTER_IN_EVERY_SNAPSHOT_QUERY)
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
import { createOrderLedger, type OrderLedger } from "@/features/trading";

const MARKET_ID = `prediction-market:polymarket:0xbug5022-${"0".repeat(56)}`;
const TOKEN_ID =
  "20000000000000000000000000000000000000000000000000000000000000022";

interface Tenant {
  userId: string;
  billingAccountId: string;
  targetId: string;
}

// Both tenants mirror the SAME target_wallet — that's the bug shape. Even with
// distinct target_id PKs per row, the legacy snapshotState filtered on
// `targetId` only (`uuidv5(target_wallet)` shared across tenants today in
// production — verified in `target-id.ts`). For this test we use distinct
// target_ids per row but stamp the SAME target_id value across both tenants
// to exercise the bug.5022 surface directly.
const SHARED_TARGET_ID = randomUUID();

async function seedTenant(label: string): Promise<Tenant> {
  const seeded = await seedAuthenticatedUser(getSeedDb(), {
    id: randomUUID(),
    walletAddress: generateTestWallet(`bug5022-${label}`),
    name: `bug5022-${label}`,
  });
  const [target] = await getSeedDb()
    .insert(polyCopyTradeTargets)
    .values({
      id: SHARED_TARGET_ID,
      billingAccountId: seeded.billingAccount.id,
      createdByUserId: seeded.user.id,
      targetWallet: generateTestWallet(`bug5022-tgt-${label}`).toLowerCase(),
    })
    .onConflictDoNothing()
    .returning({ id: polyCopyTradeTargets.id });
  // `onConflictDoNothing` returns empty when the SHARED_TARGET_ID was already
  // inserted by the prior tenant — that's the expected path here, since the
  // test wants both tenants to share the target_id PK. Look up the existing
  // row in that case.
  const targetId =
    target?.id ??
    (
      await getSeedDb()
        .select({ id: polyCopyTradeTargets.id })
        .from(polyCopyTradeTargets)
    ).find((r) => r.id === SHARED_TARGET_ID)?.id;
  if (!targetId) throw new Error("failed to seed target");
  return {
    userId: seeded.user.id,
    billingAccountId: seeded.billingAccount.id,
    targetId,
  };
}

async function seedFill(
  t: Tenant,
  opts: { sizeUsdc: number; limitPrice: number; status?: "pending" | "filled" }
): Promise<{ fillId: string; coid: string }> {
  const fillId = `data-api:${randomUUID()}`;
  const coid = `0x${randomUUID().replace(/-/g, "")}`;
  await getSeedDb()
    .insert(polyCopyTradeFills)
    .values({
      billingAccountId: t.billingAccountId,
      createdByUserId: t.userId,
      targetId: t.targetId,
      fillId,
      marketId: MARKET_ID,
      observedAt: new Date(),
      clientOrderId: coid,
      orderId: null,
      status: opts.status ?? "filled",
      attributes: {
        market_id: MARKET_ID,
        token_id: TOKEN_ID,
        side: "BUY",
        size_usdc: opts.sizeUsdc,
        limit_price: opts.limitPrice,
      },
    });
  return { fillId, coid };
}

describe("order-ledger tenant isolation — bug.5022 regression (component)", () => {
  let tenantA: Tenant;
  let tenantB: Tenant;
  let ledger: OrderLedger;

  beforeEach(async () => {
    tenantA = await seedTenant("A");
    tenantB = await seedTenant("B");
    ledger = createOrderLedger({
      db: getSeedDb() as unknown as import("drizzle-orm/node-postgres").NodePgDatabase,
      logger: noopLogger,
    });
  });

  afterEach(async () => {
    const { billingAccounts, users } = await import("@/shared/db/schema");
    const { eq } = await import("drizzle-orm");
    for (const t of [tenantA, tenantB]) {
      await getSeedDb()
        .delete(billingAccounts)
        .where(eq(billingAccounts.id, t.billingAccountId));
      await getSeedDb().delete(users).where(eq(users.id, t.userId));
    }
  });

  it("legacy snapshotState filters on (target_id, billing_account_id) — tenant B's fills do NOT pollute tenant A's snapshot", async () => {
    // Seed asymmetrically: A gets one fill, B gets two — enough that any
    // cross-tenant leak shows up as inflated counts on A.
    const a1 = await seedFill(tenantA, { sizeUsdc: 5, limitPrice: 0.5 });
    await seedFill(tenantB, { sizeUsdc: 100, limitPrice: 0.5 });
    await seedFill(tenantB, { sizeUsdc: 200, limitPrice: 0.5 });

    const snapA = await ledger.snapshotState(
      tenantA.targetId,
      tenantA.billingAccountId
    );

    expect(snapA.today_spent_usdc).toBeCloseTo(5, 4);
    expect(snapA.fills_last_hour).toBe(1);
    expect(snapA.already_placed_ids).toEqual([a1.coid]);
    expect(snapA.placed_fill_ids).toEqual([a1.fillId]);
    // position_aggregates was the loud failure surface in prod: tenant A
    // saw $300 worth of B's shares as its own → gap_shares ≤ 0 →
    // followup_not_needed loop. Confirm A sees only its own $5 / 10 shares.
    expect(snapA.position_aggregates).toHaveLength(1);
    expect(snapA.position_aggregates[0]?.gross_usdc_in).toBeCloseTo(5, 4);
    expect(snapA.position_aggregates[0]?.net_shares).toBeCloseTo(10, 4);
  });

  it("forTenant(ctx).snapshotState() matches the legacy form for the same tenant — back-compat", async () => {
    await seedFill(tenantA, { sizeUsdc: 7, limitPrice: 0.5 });
    await seedFill(tenantB, { sizeUsdc: 999, limitPrice: 0.5 });

    const legacyA = await ledger.snapshotState(
      tenantA.targetId,
      tenantA.billingAccountId
    );
    const envelopeA = await ledger
      .forTenant({
        billing_account_id: tenantA.billingAccountId,
        created_by_user_id: tenantA.userId,
      })
      .snapshotState(tenantA.targetId);

    expect(envelopeA).toStrictEqual(legacyA);
    expect(envelopeA.today_spent_usdc).toBeCloseTo(7, 4);
    // forTenant must also not leak B's $999 into A's snapshot.
    expect(envelopeA.position_aggregates[0]?.gross_usdc_in).toBeCloseTo(7, 4);
  });

  it("each tenant sees ONLY its own fills under the shared target_id (symmetric)", async () => {
    await seedFill(tenantA, { sizeUsdc: 11, limitPrice: 0.5 });
    await seedFill(tenantA, { sizeUsdc: 22, limitPrice: 0.5 });
    await seedFill(tenantB, { sizeUsdc: 333, limitPrice: 0.5 });

    const snapA = await ledger
      .forTenant({
        billing_account_id: tenantA.billingAccountId,
        created_by_user_id: tenantA.userId,
      })
      .snapshotState(tenantA.targetId);
    const snapB = await ledger
      .forTenant({
        billing_account_id: tenantB.billingAccountId,
        created_by_user_id: tenantB.userId,
      })
      .snapshotState(tenantB.targetId);

    expect(snapA.today_spent_usdc).toBeCloseTo(33, 4);
    expect(snapB.today_spent_usdc).toBeCloseTo(333, 4);
    expect(snapA.fills_last_hour).toBe(2);
    expect(snapB.fills_last_hour).toBe(1);
    // Position aggregates must be independent — was the prod leak surface.
    expect(snapA.position_aggregates[0]?.gross_usdc_in).toBeCloseTo(33, 4);
    expect(snapB.position_aggregates[0]?.gross_usdc_in).toBeCloseTo(333, 4);
  });
});
