// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-core/tsup.config`
 * Purpose: tsup build configuration for poly-core package.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output must be ESM with type declarations.
 * Side-effects: IO
 * Links: work/items/task.0227.poly-mvp-agent-workflows-and-taps.md
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "neutral",
  external: ["@cogni/ingestion-core", "@cogni/market-provider", "zod"],
});

export default tsupConfig;
