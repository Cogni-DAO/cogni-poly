// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/infratest-shape-a-service/tsup.config`
 * Purpose: Build config - transpile-only (no bundling) so pino's runtime `require('os')` + worker-thread spawn resolve from real `node_modules` at startup.
 * Scope: Defines tsup settings. Does not contain runtime code.
 * Invariants:
 *   - ESM_FORMAT_ONLY
 *   - BUNDLE_FALSE_FOR_NATIVE_REQUIRES
 *   - ENTRY_GLOBS_EVERY_SRC_FILE
 * Side-effects: none
 * Links: services/infratest-shape-a/Dockerfile (copies node_modules + dist into runner)
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
