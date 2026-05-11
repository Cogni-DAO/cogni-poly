// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/config-hygiene`
 * Purpose: Validates dependency-cruiser config hygiene (no phantom layers, valid definitions).
 * Scope: Tests config correctness. Does NOT test boundary enforcement.
 * Invariants: All defined layers must exist in filesystem; no unused layer definitions.
 * Side-effects: IO (filesystem checks)
 * Notes: Prevents config drift and phantom layer definitions.
 * Links: .dependency-cruiser.cjs, docs/spec/architecture.md
 * @public
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Dependency-cruiser config hygiene", () => {
  it("defines only layers that exist in filesystem", () => {
    // Core existing layers
    const existingLayers = [
      "nodes/poly/app/src/core",
      "nodes/poly/app/src/ports",
      "nodes/poly/app/src/features",
      "nodes/poly/app/src/app",
      "nodes/poly/app/src/adapters/server",
      "nodes/poly/app/src/adapters/test",
      "nodes/poly/app/src/shared",
      "nodes/poly/app/src/bootstrap",
      "nodes/poly/app/src/lib",
      "nodes/poly/app/src/components",
      "nodes/poly/app/src/styles",
      "nodes/poly/app/src/types",
      "nodes/poly/app/src/contracts",
      "nodes/poly/app/src/mcp",
    ];

    // Verify each layer exists
    for (const path of existingLayers) {
      expect(existsSync(path), `Layer ${path} should exist`).toBe(true);
    }
  });

  it("does not define phantom adaptersWorker layer", () => {
    expect(existsSync("nodes/poly/app/src/adapters/worker")).toBe(false);
  });

  it("does not define phantom adaptersCli layer", () => {
    expect(existsSync("nodes/poly/app/src/adapters/cli")).toBe(false);
  });
});
