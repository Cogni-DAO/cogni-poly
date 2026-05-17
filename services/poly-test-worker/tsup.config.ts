// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  bundle: true,
  splitting: false,
  dts: false,
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node22",
  noExternal: ["pino", "zod"],
});
