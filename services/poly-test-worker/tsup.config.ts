// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-test-worker-service/tsup.config`
 * Purpose: Build config for poly-test-worker — transpile-only (no bundling) so packages with runtime `require()` of native modules (pino → `require('os')`, thread-stream workers, etc.) load from real `node_modules` at startup instead of crashing the ESM bundle.
 * Scope: Defines tsup settings. Does not contain runtime code.
 * Invariants:
 *   - ESM_FORMAT_ONLY
 *   - BUNDLE_FALSE_FOR_NATIVE_REQUIRES
 *   - ENTRY_GLOBS_EVERY_SRC_FILE
 * Side-effects: none
 * Links: services/poly-test-worker/Dockerfile (copies node_modules + dist into runner)
 * @internal
 */

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["esm"],
  bundle: false,
  splitting: false,
  dts: false,
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node22",
});
