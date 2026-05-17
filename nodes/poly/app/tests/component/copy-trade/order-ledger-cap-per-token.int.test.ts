// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/copy-trade/order-ledger-cap-per-token.int`
 * Purpose: Real-Postgres proof of `CAP_IS_PER_TOKEN_ID` (bug.5004). Exercises
 *          the prod `createOrderLedger` adapter (NOT the in-memory fake) so
 *          the SQL `WHERE attributes->>'token_id'` filter + the narrowed
 *          `pg_advisory_xact_lock('${billing}:${market}:${token}')` key are
 *          proven against the same Postgres + jsonb operators that ship.
 * Scope: One condition, two outcome tokens (YES + NO), one tenant. No HTTP,
 *        no mirror-pipeline; talks directly to the adapter.
 * Invariants tested:
 *   - `cumulativeIntentForMarketToken` is scoped per token_id — intent on
 *     token A returns A's sum and NOT B's.
 *   - The atomic SELECT inside `insertPending` (lock-protected) lets a
 *     token-B insert through after the cap is fully consumed on token A.
 *   - Empty-string token_id on the intent (`buildIntent`'s malformed-fill
 *     fallback) bypasses the atomic check rather than scoping to "" and
 *     silently leaking past the cap.
 * Side-effects: writes 1 user + 1 billing account + 1 target + N fills.
 *               Tears down via `billing_accounts CASCADE`.
 * Links: docs/spec/poly-copy-trade-execution.md (CAP_IS_PER_TOKEN_ID),
 *        src/features/trading/order-ledger.ts
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

const MARKET_ID = `prediction-market:polymarket:0xbug5004-${"0".repeat(56)}`;
const TOKEN_A =
  "10000000000000000000000000000000000000000000000000000000000000001";
const TOKEN_B =
  "10000000000000000000000000000000000000000000000000000000000000002";

interface Tenant {
  userId: string;
  billingAccountId: string;
  targetId: string;
}

async function seedTenant(): Promise<Tenant> {
  const seeded = await seedAuthenticatedUser(getSeedDb(), {
    id: randomUUID(),
    walletAddress: generateTestWallet(`cap-per-token`),
    name: `cap-per-token`,
  });
  const [target] = await getSeedDb()
    .insert(polyCopyTradeTargets)
    .values({
      billingAccountId: seeded.billingAccount.id,
      createdByUserId: seeded.user.id,
      targetWallet: generateTestWallet(`tgt-cap`).toLowerCase(),
    })
    .returning({ id: polyCopyTradeTargets.id });
  if (!target) throw new Error("failed to seed target");
  return {
    userId: seeded.user.id,
    billingAccountId: seeded.billingAccount.id,
    targetId: target.id,
  };
}

async function seedFill(
  t: Tenant,
  opts: { tokenId: string; sizeUsdc: number; status?: "pending" | "filled" }
): Promise<void> {
  const fillId = `data-api:${randomUUID()}`;
  await getSeedDb()
    .insert(polyCopyTradeFills)
    .values({
      billingAccountId: t.billingAccountId,
      createdByUserId: t.userId,
      targetId: t.targetId,
      fillId,
      marketId: MARKET_ID,
      observedAt: new Date(),
      clientOrderId: `coid-${randomUUID()}`,
      orderId: null,
      status: opts.status ?? "filled",
      attributes: {
        market_id: MARKET_ID,
        token_id: opts.tokenId,
        side: "BUY",
        size_usdc: opts.sizeUsdc,
      },
    });
}

describe("order-ledger CAP_IS_PER_TOKEN_ID — real Postgres (component)", () => {
  let tenant: Tenant;
  let ledger: OrderLedger;

  beforeEach(async () => {
    tenant = await seedTenant();
    ledger = createOrderLedger({
      db: getSeedDb() as unknown as import("drizzle-orm/node-postgres").NodePgDatabase,
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

  it("cumulativeIntentForMarketToken scopes the sum per token_id (SQL contract)", async () => {
    await seedFill(tenant, { tokenId: TOKEN_A, sizeUsdc: 14 });
    await seedFill(tenant, {
      tokenId: TOKEN_A,
      sizeUsdc: 6,
      status: "pending",
    });
    await seedFill(tenant, { tokenId: TOKEN_B, sizeUsdc: 99 });

    await expect(
      ledger.cumulativeIntentForMarketToken(
        tenant.billingAccountId,
        MARKET_ID,
        TOKEN_A
      )
    ).resolves.toBeCloseTo(20, 4);
    await expect(
      ledger.cumulativeIntentForMarketToken(
        tenant.billingAccountId,
        MARKET_ID,
        TOKEN_B
      )
    ).resolves.toBeCloseTo(99, 4);
  });

  it("atomic insertPending lets token B through after the cap is consumed on token A (lock-key contract)", async () => {
    // Burn the cap on token A.
    await seedFill(tenant, { tokenId: TOKEN_A, sizeUsdc: 30 });

    // Token A — would exceed the per-leg cap; must reject with
    // PositionCapReachedError(... token_id=TOKEN_A ...).
    await expect(
      ledger.insertPending({
        billing_account_id: tenant.billingAccountId,
        created_by_user_id: tenant.userId,
        target_id: tenant.targetId,
        fill_id: `data-api:${randomUUID()}`,
        observed_at: new Date(),
        max_market_intent_usdc: 30,
        intent: {
          provider: "polymarket",
          market_id: MARKET_ID,
          outcome: "YES",
          side: "BUY",
          size_usdc: 1,
          limit_price: 0.5,
          client_order_id: `coid-a-over-${randomUUID()}`,
          attributes: { token_id: TOKEN_A },
        },
      })
    ).rejects.toMatchObject({
      code: "position_cap_reached",
      token_id: TOKEN_A,
    });

    // Token B on the SAME condition — independent per-leg budget; succeeds.
    // Different target_id so the AlreadyResting partial-unique-index doesn't
    // claim the (billing, target, market) slot.
    const [target2] = await getSeedDb()
      .insert(polyCopyTradeTargets)
      .values({
        billingAccountId: tenant.billingAccountId,
        createdByUserId: tenant.userId,
        targetWallet: generateTestWallet(`tgt-b`).toLowerCase(),
      })
      .returning({ id: polyCopyTradeTargets.id });
    if (!target2) throw new Error("failed to seed second target");

    await expect(
      ledger.insertPending({
        billing_account_id: tenant.billingAccountId,
        created_by_user_id: tenant.userId,
        target_id: target2.id,
        fill_id: `data-api:${randomUUID()}`,
        observed_at: new Date(),
        max_market_intent_usdc: 30,
        intent: {
          provider: "polymarket",
          market_id: MARKET_ID,
          outcome: "NO",
          side: "BUY",
          size_usdc: 25,
          limit_price: 0.5,
          client_order_id: `coid-b-fresh-${randomUUID()}`,
          attributes: { token_id: TOKEN_B },
        },
      })
    ).resolves.toBeUndefined();

    // Sanity: token-B aggregate reflects the new pending row; token-A unchanged.
    await expect(
      ledger.cumulativeIntentForMarketToken(
        tenant.billingAccountId,
        MARKET_ID,
        TOKEN_B
      )
    ).resolves.toBeCloseTo(25, 4);
    await expect(
      ledger.cumulativeIntentForMarketToken(
        tenant.billingAccountId,
        MARKET_ID,
        TOKEN_A
      )
    ).resolves.toBeCloseTo(30, 4);
  });

  it("empty-string token_id bypasses the atomic check (does not scope to '' and silently match nothing)", async () => {
    await seedFill(tenant, { tokenId: TOKEN_A, sizeUsdc: 30 });

    // With cap=1 and intent token_id="" the check MUST bypass — otherwise it
    // would scope to "" (matching zero rows), see 0 + 100 ≤ 1 as false, and
    // also fail to count the $30 burnt on TOKEN_A. The intentional contract
    // is "fail open on malformed fill" (logged upstream), not silent leak.
    await expect(
      ledger.insertPending({
        billing_account_id: tenant.billingAccountId,
        created_by_user_id: tenant.userId,
        target_id: tenant.targetId,
        fill_id: `data-api:${randomUUID()}`,
        observed_at: new Date(),
        max_market_intent_usdc: 1,
        intent: {
          provider: "polymarket",
          market_id: MARKET_ID,
          outcome: "YES",
          side: "BUY",
          size_usdc: 100,
          limit_price: 0.5,
          client_order_id: `coid-empty-${randomUUID()}`,
          attributes: { token_id: "" },
        },
      })
    ).resolves.toBeUndefined();
  });
});
