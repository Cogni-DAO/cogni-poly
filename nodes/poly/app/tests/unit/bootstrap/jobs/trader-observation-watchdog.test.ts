// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/jobs/trader-observation-watchdog`
 * Purpose: Verify the watchdog around `runTraderObservationTick` releases the
 *   `running` lock when the underlying tick exceeds `TICK_TIMEOUT_MS`, so a
 *   single hung HTTP/DB call can't freeze the position read-model snapshot
 *   that powers the dashboard.
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
  const stops: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    mockRunTraderObservationTick.mockReset();
  });

  afterEach(() => {
    for (const stop of stops) stop();
    stops.length = 0;
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
    stops.push(stop);

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
  });
});
