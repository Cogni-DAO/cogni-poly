// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/trading/order-ledger-mode-stamping`
 * Purpose: Regression guard for MODE_STAMPED_AT_LEDGER_FROM_ENV (task.5003).
 *   The Drizzle ledger is the single write authority for
 *   `poly_copy_trade_{fills,decisions}.mode`. Every insert MUST stamp the
 *   row's `mode` from the `paperEnforceMode` dep — never from intent
 *   attributes or any other shadow. Pair invariant:
 *   PAPER_DISPATCH_IS_ENV_ONLY (poly-trade-executor.ts).
 * Scope: Unit test with a mocked Drizzle insert chain that captures the
 *   `values` payload. No DB, no DI.
 * Side-effects: none
 * Links: nodes/poly/app/src/features/trading/order-ledger.ts (createOrderLedger)
 * @internal
 */

import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import {
  createOrderLedger,
  type OrderLedgerDeps,
} from "@/features/trading/order-ledger";
import type {
  InsertPendingInput,
  RecordDecisionInput,
} from "@/features/trading/order-ledger.types";

interface CapturedInsert {
  values?: Record<string, unknown>;
}

type LedgerDb = OrderLedgerDeps["db"];

function makeMockDb(captured: CapturedInsert): LedgerDb {
  const chain = {
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        captured.values = v;
        return {
          onConflictDoNothing: (_opts?: unknown) => Promise.resolve(),
        };
      },
    }),
  };
  return chain as unknown as LedgerDb;
}

function makeLogger(): Logger {
  const noop = (..._args: unknown[]): void => undefined;
  const stub = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    trace: noop,
    child: () => stub,
  } as unknown as Logger;
  return stub;
}

const insertInput: InsertPendingInput = {
  billing_account_id: "ba-1",
  created_by_user_id: "user-1",
  target_id: "00000000-0000-0000-0000-000000000001",
  fill_id: "data-api:abc",
  observed_at: new Date("2026-05-16T12:00:00Z"),
  intent: {
    provider: "polymarket",
    market_id: "prediction-market:polymarket:0xabc",
    outcome: "YES",
    side: "BUY",
    size_usdc: 5,
    limit_price: 0.42,
    client_order_id: "0xdeadbeef",
    attributes: { token_id: "tok-1" },
  },
};

const decisionInput: RecordDecisionInput = {
  billing_account_id: "ba-1",
  created_by_user_id: "user-1",
  target_id: "00000000-0000-0000-0000-000000000001",
  fill_id: "data-api:abc",
  outcome: "skipped",
  reason: "already_placed",
  intent: { mode: "live", target_wallet: "0xT" },
  receipt: null,
  decided_at: new Date("2026-05-16T12:00:00Z"),
};

describe("createOrderLedger — MODE_STAMPED_AT_LEDGER_FROM_ENV", () => {
  it("insertPending stamps mode='paper' when paperEnforceMode='paper'", async () => {
    const captured: CapturedInsert = {};
    const ledger = createOrderLedger({
      db: makeMockDb(captured),
      logger: makeLogger(),
      paperEnforceMode: "paper",
    });
    await ledger.insertPending(insertInput);
    expect(captured.values?.mode).toBe("paper");
  });

  it("insertPending stamps mode='live' when paperEnforceMode is undefined", async () => {
    const captured: CapturedInsert = {};
    const ledger = createOrderLedger({
      db: makeMockDb(captured),
      logger: makeLogger(),
    });
    await ledger.insertPending(insertInput);
    expect(captured.values?.mode).toBe("live");
  });

  it("recordDecision stamps mode='paper' when paperEnforceMode='paper'", async () => {
    const captured: CapturedInsert = {};
    const ledger = createOrderLedger({
      db: makeMockDb(captured),
      logger: makeLogger(),
      paperEnforceMode: "paper",
    });
    await ledger.recordDecision(decisionInput);
    expect(captured.values?.mode).toBe("paper");
  });

  it("recordDecision stamps mode='live' when paperEnforceMode is undefined", async () => {
    const captured: CapturedInsert = {};
    const ledger = createOrderLedger({
      db: makeMockDb(captured),
      logger: makeLogger(),
    });
    await ledger.recordDecision(decisionInput);
    expect(captured.values?.mode).toBe("live");
  });

  it("intent.attributes.mode is ignored — only paperEnforceMode dep matters", async () => {
    const captured: CapturedInsert = {};
    const ledger = createOrderLedger({
      db: makeMockDb(captured),
      logger: makeLogger(),
      // env says live — even a paper-labelled intent must NOT win.
    });
    await ledger.insertPending({
      ...insertInput,
      intent: {
        ...insertInput.intent,
        attributes: { ...insertInput.intent.attributes, mode: "paper" },
      },
    });
    expect(captured.values?.mode).toBe("live");
  });
});
