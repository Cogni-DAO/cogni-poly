// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/jobs/trader-observation-watchdog`
 * Purpose: Verify the 120s watchdog around `runTraderObservationTick` so a
 *   single hung HTTP call or DB connection can never freeze the in-flight
 *   `running` flag for hours (which silently froze the dashboard's positions
 *   widget against a stale snapshot in prod on 2026-05-13).
 * Scope: Job-level only; mocks the tick function.
 * @internal
 */

import { noopMetrics } from "@cogni/poly-market-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRunTraderObservationTick = vi.fn();

vi.mock("@/features/wallet-analysis/server/trader-observation-service", () => ({
  runTraderObservationTick: mockRunTraderObservationTick,
}));

describe("startTraderObservationJob — watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunTraderObservationTick.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases the running lock when a tick exceeds TICK_TIMEOUT_MS", async () => {
    // First tick never resolves. Without the watchdog this freezes `running`.
    let firstTickResolve!: () => void;
    mockRunTraderObservationTick.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        firstTickResolve = resolve;
      })
    );

    const errors: unknown[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((fields: unknown) => {
        errors.push(fields);
      }),
      child: vi.fn().mockReturnThis(),
    };

    const { startTraderObservationJob } = await import(
      "@/bootstrap/jobs/trader-observation.job"
    );

    const stop = startTraderObservationJob({
      db: {} as never,
      client: {} as never,
      logger: logger as never,
      metrics: noopMetrics,
      pollMs: 30_000,
    });

    // Let the immediate tick start.
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeWatchdog = mockRunTraderObservationTick.mock.calls.length;
    expect(callsBeforeWatchdog).toBe(1);

    // Cross the 120s watchdog boundary; the tick must reject + release lock.
    await vi.advanceTimersByTimeAsync(120_001);

    expect(errors).toContainEqual(
      expect.objectContaining({
        phase: "tick_error",
        err: expect.stringContaining("exceeded 120000ms"),
        timeout_ms: 120_000,
      })
    );

    // After the watchdog, the next scheduled tick must be able to actually
    // run. Without the fix it would skip with "previous tick still running"
    // forever. Advance one full poll interval and assert we made at least one
    // additional invocation of the underlying tick body.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockRunTraderObservationTick.mock.calls.length).toBeGreaterThan(
      callsBeforeWatchdog
    );

    firstTickResolve();
    stop();
  });
});
