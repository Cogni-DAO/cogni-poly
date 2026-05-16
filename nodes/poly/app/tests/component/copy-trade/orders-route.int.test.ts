// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/copy-trade/orders-route.int`
 * Purpose: HTTP round-trip test for `/api/v1/poly/copy-trade/orders` — proves
 *          tenant isolation: two tenants each insert a fill row; each session
 *          sees only their own row. Closes the bug fixed in this branch where
 *          the route ran an unscoped `listRecent()` and returned the global
 *          ledger to every caller (TODO HARDCODED_USER).
 * Scope: HTTP layer. Mocks getSessionUser; runs against testcontainers Postgres.
 *        Asserts on response body — does NOT touch the autonomous mirror loop.
 * Invariants tested:
 *   - TENANT_SCOPED: tenant A's response contains tenant A's fill and NOT
 *     tenant B's fill, and vice versa.
 *   - `mode` field is surfaced (`live` for the legacy default).
 * Side-effects: writes 2 users + 2 billing accounts + 2 targets + 2 fills.
 * Links: src/app/api/v1/poly/copy-trade/orders/route.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import type { SessionUser } from "@cogni/node-shared";
import {
  polyCopyTradeFills,
  polyCopyTradeTargets,
} from "@cogni/poly-db-schema";
import {
  generateTestWallet,
  seedAuthenticatedUser,
} from "@tests/_fixtures/auth/db-helpers";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

import { getSessionUser } from "@/app/_lib/auth/session";
import { GET as listOrders } from "@/app/api/v1/poly/copy-trade/orders/route";

interface TenantFixture {
  sessionUser: SessionUser;
  userId: string;
  billingAccountId: string;
  targetId: string;
  fillId: string;
  marketId: string;
}

async function seedTenant(label: string): Promise<TenantFixture> {
  const seeded = await seedAuthenticatedUser(getSeedDb(), {
    id: randomUUID(),
    walletAddress: generateTestWallet(`orders-route-${label}`),
    name: `Orders Route ${label}`,
  });
  if (!seeded.user.walletAddress) {
    throw new Error("test user missing walletAddress");
  }

  // Active target row owned by this tenant.
  const [target] = await getSeedDb()
    .insert(polyCopyTradeTargets)
    .values({
      billingAccountId: seeded.billingAccount.id,
      createdByUserId: seeded.user.id,
      targetWallet: generateTestWallet(`target-${label}`).toLowerCase(),
    })
    .returning({ id: polyCopyTradeTargets.id });
  if (!target) throw new Error("failed to seed target");

  // One ledger fill row owned by this tenant. fill_id format must match the
  // CHECK constraint `^(data-api|clob-ws):.+`.
  const fillId = `data-api:${label}-${randomUUID()}`;
  const marketId = `prediction-market:polymarket:0x${label}${"0".repeat(63 - label.length)}`;
  await getSeedDb()
    .insert(polyCopyTradeFills)
    .values({
      billingAccountId: seeded.billingAccount.id,
      createdByUserId: seeded.user.id,
      targetId: target.id,
      fillId,
      marketId,
      observedAt: new Date(),
      clientOrderId: `coid-${label}-${randomUUID()}`,
      orderId: null,
      status: "pending",
      attributes: { market_id: marketId, side: "BUY", size_usdc: 1 },
    });

  return {
    sessionUser: {
      id: seeded.user.id,
      walletAddress: seeded.user.walletAddress,
      displayName: null,
      avatarColor: null,
    },
    userId: seeded.user.id,
    billingAccountId: seeded.billingAccount.id,
    targetId: target.id,
    fillId,
    marketId,
  };
}

describe("poly.copy_trade.orders — tenant isolation (component)", () => {
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeEach(async () => {
    vi.clearAllMocks();
    tenantA = await seedTenant("a");
    tenantB = await seedTenant("b");
  });

  afterEach(async () => {
    // billing_accounts CASCADE → targets + fills. Delete users last.
    const { billingAccounts, users } = await import("@/shared/db/schema");
    const ids = [tenantA.billingAccountId, tenantB.billingAccountId];
    const userIds = [tenantA.userId, tenantB.userId];
    await getSeedDb()
      .delete(billingAccounts)
      .where(inArray(billingAccounts.id, ids));
    await getSeedDb().delete(users).where(inArray(users.id, userIds));
  });

  it("tenant A sees only its own fill row; tenant B sees only its own", async () => {
    // ── Caller = tenant A ────────────────────────────────────────────────
    vi.mocked(getSessionUser).mockResolvedValueOnce(tenantA.sessionUser);
    const resA = await listOrders(
      new NextRequest("http://localhost/api/v1/poly/copy-trade/orders")
    );
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as {
      orders: Array<{
        fill_id: string;
        target_id: string;
        market_id: string | null;
        mode: "live" | "paper" | null;
      }>;
    };
    const fillIdsA = bodyA.orders.map((o) => o.fill_id);
    expect(fillIdsA).toContain(tenantA.fillId);
    expect(fillIdsA).not.toContain(tenantB.fillId);
    // Mode column defaults to 'live' (migration 0049).
    const tenantARow = bodyA.orders.find((o) => o.fill_id === tenantA.fillId);
    expect(tenantARow?.mode).toBe("live");

    // ── Caller = tenant B ────────────────────────────────────────────────
    vi.mocked(getSessionUser).mockResolvedValueOnce(tenantB.sessionUser);
    const resB = await listOrders(
      new NextRequest("http://localhost/api/v1/poly/copy-trade/orders")
    );
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as {
      orders: Array<{ fill_id: string }>;
    };
    const fillIdsB = bodyB.orders.map((o) => o.fill_id);
    expect(fillIdsB).toContain(tenantB.fillId);
    expect(fillIdsB).not.toContain(tenantA.fillId);
  });

  it("target_id filter is still tenant-clamped — A cannot pull B's rows by passing B's target_id", async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce(tenantA.sessionUser);
    const res = await listOrders(
      new NextRequest(
        `http://localhost/api/v1/poly/copy-trade/orders?target_id=${tenantB.targetId}`
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<{ fill_id: string }> };
    // Even though target_id matches B's row, the tenant clamp must drop it.
    expect(body.orders.map((o) => o.fill_id)).not.toContain(tenantB.fillId);
    expect(body.orders).toHaveLength(0);
  });

  it("legacy: assert seed row is actually visible via service-role read (sanity)", async () => {
    // Pure sanity check — proves the seed pipeline produced reachable rows,
    // so a `[]` response from the route above is meaningful (not vacuous).
    const seenA = await getSeedDb()
      .select({ fillId: polyCopyTradeFills.fillId })
      .from(polyCopyTradeFills)
      .where(eq(polyCopyTradeFills.fillId, tenantA.fillId));
    expect(seenA).toHaveLength(1);
    const seenB = await getSeedDb()
      .select({ fillId: polyCopyTradeFills.fillId })
      .from(polyCopyTradeFills)
      .where(eq(polyCopyTradeFills.fillId, tenantB.fillId));
    expect(seenB).toHaveLength(1);
  });
});
