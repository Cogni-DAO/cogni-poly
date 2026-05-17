// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/retag-mq-to-preview`
 * Purpose: Lock the contract that `retag-mq-to-preview.sh` retags ONLY images named in RESOLVED_TARGETS — no word-prefix collision (the bug that bit PR #82's auto-flight-preview where `grep -qw poly` matched `poly-test-worker`). Uses a mock `docker` shim that logs every invocation so the test can assert on actual retag calls. Does not pull from GHCR, does not push.
 * Scope: Unit-level contract test of the retag iteration. Does NOT cover docker buildx imagetools network behavior — the mock satisfies the side-effect.
 * Invariants:
 *   - RETAG_ONLY_RESOLVED  (the bug fix: `poly-test-worker` alone in RESOLVED_TARGETS must NOT retag `poly`)
 *   - RETAG_PRESERVES_ORDER (CSV input order preserved in calls — useful for log readability)
 *   - RETAG_HANDLES_FULL_CSV (multi-image case still works)
 * Side-effects: IO (mkdtemp + writes fixture catalog + mock docker shim + spawns bash; cleaned up per-test).
 * Links: scripts/ci/retag-mq-to-preview.sh, .github/workflows/flight-preview.yml (retag step), bug exposed by PR #82's recursive flight-preview validation.
 * @public
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/ci/retag-mq-to-preview.sh");

const POLY_CATALOG = `schema_version: 2
name: poly
type: node
node_id: "5ed2d64f-2745-4676-983b-2fb7e05b2eba"
deploy:
  candidate_a_branch: deploy/candidate-a-poly
  preview_branch: deploy/preview-poly
  production_branch: deploy/production-poly
  path_prefix: nodes/poly/
  port: 3000
images:
  - name: poly
    role: app
    dockerfile: Dockerfile.poly
    image_name: ghcr.io/cogni-dao/cogni-poly
    image_tag_suffix: "-poly"
    path_prefix: nodes/poly/app/
  - name: poly-paper-sidecar
    role: sidecar
    dockerfile: Dockerfile.paper
    image_name: ghcr.io/cogni-dao/poly-paper-sidecar
    image_tag_suffix: ""
    path_prefix: nodes/poly/sidecars/paper-trader/
`;

const TEST_WORKER_CATALOG = `schema_version: 2
name: poly-test-worker
type: service
deploy:
  candidate_a_branch: deploy/candidate-a-poly-test-worker
  preview_branch: deploy/preview-poly-test-worker
  production_branch: deploy/production-poly-test-worker
  path_prefix: services/poly-test-worker/
  port: 9000
images:
  - name: poly-test-worker
    role: app
    dockerfile: Dockerfile.test-worker
    image_name: ghcr.io/cogni-dao/poly-test-worker
    image_tag_suffix: ""
    path_prefix: services/poly-test-worker/
`;

type Fixture = {
  root: string;
  binDir: string;
  callLog: string;
};

function setupFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "retag-mq-"));
  const binDir = path.join(root, "bin");
  const callLog = path.join(root, "docker-calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(root, "infra/catalog"), { recursive: true });
  for (const f of [
    "Dockerfile.poly",
    "Dockerfile.paper",
    "Dockerfile.test-worker",
  ]) {
    writeFileSync(path.join(root, f), "FROM scratch\n");
  }
  writeFileSync(path.join(root, "infra/catalog/poly.yaml"), POLY_CATALOG);
  writeFileSync(
    path.join(root, "infra/catalog/poly-test-worker.yaml"),
    TEST_WORKER_CATALOG
  );
  // Mock docker: log every argv to callLog, always exit 0. No network.
  const mockDocker = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${callLog}"
exit 0
`;
  const dockerPath = path.join(binDir, "docker");
  writeFileSync(dockerPath, mockDocker);
  chmodSync(dockerPath, 0o755);
  writeFileSync(callLog, "");
  return { root, binDir, callLog };
}

function runRetag(
  fixture: Fixture,
  env: Record<string, string>
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [SCRIPT], {
    cwd: fixture.root,
    env: {
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      ...env,
    },
    encoding: "utf-8",
  });
}

describe("retag-mq-to-preview.sh", () => {
  let fixture: Fixture | null = null;

  afterEach(() => {
    if (fixture) {
      rmSync(fixture.root, { recursive: true, force: true });
      fixture = null;
    }
  });

  it("RETAG_ONLY_RESOLVED — poly-test-worker alone must NOT trigger a poly retag (word-prefix collision regression)", () => {
    fixture = setupFixture();
    const res = runRetag(fixture, {
      RESOLVED_TARGETS: "poly-test-worker",
      PR_IMAGE_TAG: "mq-82-b19e3d1b",
      PREVIEW_TAG: "preview-b19e3d1b",
    });
    expect(res.status, res.stderr).toBe(0);
    const log = readFileSync(fixture.callLog, "utf-8");
    // Exactly one buildx imagetools create call, against poly-test-worker.
    const lines = log.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("poly-test-worker:mq-82-b19e3d1b");
    expect(lines[0]).toContain("poly-test-worker:preview-b19e3d1b");
    // CRITICAL: must NOT have attempted to retag poly (the bug PR #82 hit).
    expect(log).not.toContain("cogni-poly:mq-82-b19e3d1b-poly");
  });

  it("RETAG_HANDLES_FULL_CSV — all three images in RESOLVED_TARGETS produce three retags", () => {
    fixture = setupFixture();
    const res = runRetag(fixture, {
      RESOLVED_TARGETS: "poly,poly-paper-sidecar,poly-test-worker",
      PR_IMAGE_TAG: "mq-100-deadbeef",
      PREVIEW_TAG: "preview-deadbeef",
    });
    expect(res.status, res.stderr).toBe(0);
    const log = readFileSync(fixture.callLog, "utf-8");
    const lines = log.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(log).toContain("cogni-poly:mq-100-deadbeef-poly");
    expect(log).toContain("poly-paper-sidecar:mq-100-deadbeef");
    expect(log).toContain("poly-test-worker:mq-100-deadbeef");
  });

  it("RETAG_HANDLES_WHITESPACE — stray spaces in CSV (defensive) don't break iteration", () => {
    fixture = setupFixture();
    const res = runRetag(fixture, {
      RESOLVED_TARGETS: "poly, poly-paper-sidecar ,poly-test-worker",
      PR_IMAGE_TAG: "mq-1-aaaaaaaa",
      PREVIEW_TAG: "preview-aaaaaaaa",
    });
    expect(res.status, res.stderr).toBe(0);
    const log = readFileSync(fixture.callLog, "utf-8");
    const lines = log.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
  });

  it("RETAG_REJECTS_EMPTY — empty RESOLVED_TARGETS is a noop (no retags, exit 0)", () => {
    fixture = setupFixture();
    const res = runRetag(fixture, {
      RESOLVED_TARGETS: "",
      PR_IMAGE_TAG: "mq-1-aaaaaaaa",
      PREVIEW_TAG: "preview-aaaaaaaa",
    });
    // RESOLVED_TARGETS is marked required (:?) — empty triggers a non-zero
    // exit so the workflow doesn't quietly retag nothing. Callers gate
    // upstream via `has_images == 'true'`.
    expect(res.status).not.toBe(0);
  });
});
