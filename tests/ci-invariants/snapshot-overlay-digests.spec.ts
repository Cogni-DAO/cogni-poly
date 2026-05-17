// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/snapshot-overlay-digests`
 * Purpose: Lock the 3-column TSV contract of `snapshot-overlay-digests.sh`
 *          (deploy_unit \t image_name \t image_ref) and prove multi-image
 *          extraction for catalog-v2 overlays (Shape B sidecars).
 * Scope: Spawns `bash scripts/ci/snapshot-overlay-digests.sh` against an isolated tmpdir fixture overlay tree; does NOT shell out to git, docker, kubectl, or any network. Asserts the TSV matches the catalog's declared images for each deploy unit.
 * Invariants:
 *   - SNAPSHOT_TSV_IS_3_COL
 *   - SNAPSHOT_HAS_ROW_PER_OVERLAY_IMAGE  (no Shape B clobber by sidecar omission)
 *   - SNAPSHOT_PRESERVES_DIGEST_PINS      (sha256:... digest pin → @sha256:...)
 *   - SNAPSHOT_PRESERVES_TAG_PINS         (newTag pin → :tag, quotes stripped)
 * Side-effects: IO (mkdtemp + writes fixture overlay files + spawns bash script in tmpdir; cleaned up in afterAll)
 * Links: scripts/ci/lib/overlay-digest.sh, .github/workflows/candidate-flight.yml
 *        (restore loop). PR fixing the v1→v2 single-image regression.
 * @public
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/ci/snapshot-overlay-digests.sh");

const POLY_OVERLAY = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: cogni-candidate-a

resources:
  - ../../../base/node-app

namePrefix: poly-

images:
  - name: ghcr.io/cogni-dao/cogni-poly
    newName: ghcr.io/cogni-dao/cogni-poly
    digest: "sha256:bae514810c27ce38d0602a560fe798f4037f0b033fb2362d4a53eabefc6e793d"
  - name: ghcr.io/cogni-dao/poly-paper-sidecar
    newName: ghcr.io/cogni-dao/poly-paper-sidecar
    digest: "sha256:e96106e8aae2478a8ee506d3f837024ac2e7a415b0cc6491bee6f4d9f541d014"
  - name: ghcr.io/cogni-dao/poly-echo-sidecar
    newName: ghcr.io/cogni-dao/poly-echo-sidecar
    newTag: "candidate-a-placeholder-poly-echo-sidecar"
`;

const SW_OVERLAY = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: cogni-candidate-a

resources:
  - ../../../base/scheduler-worker

images:
  - name: ghcr.io/cogni-dao/cogni-poly
    newName: ghcr.io/cogni-dao/cogni-poly
    digest: "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
`;

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
  - name: poly-echo-sidecar
    role: sidecar
    dockerfile: Dockerfile.echo
    image_name: ghcr.io/cogni-dao/poly-echo-sidecar
    image_tag_suffix: ""
    path_prefix: nodes/poly/sidecars/echo/
`;

const SW_CATALOG = `schema_version: 2
name: scheduler-worker
type: service
deploy:
  candidate_a_branch: deploy/candidate-a-scheduler-worker
  preview_branch: deploy/preview-scheduler-worker
  production_branch: deploy/production-scheduler-worker
  path_prefix: services/scheduler-worker/
  port: 9000
images:
  - name: scheduler-worker
    role: app
    dockerfile: Dockerfile.sw
    image_name: ghcr.io/cogni-dao/cogni-poly
    image_tag_suffix: "-scheduler-worker"
`;

describe("snapshot-overlay-digests TSV contract", () => {
  let fixtureRoot: string;
  let output: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "snap-overlay-"));
    mkdirSync(path.join(fixtureRoot, "infra/catalog"), { recursive: true });
    mkdirSync(path.join(fixtureRoot, "infra/k8s/overlays/candidate-a/poly"), {
      recursive: true,
    });
    mkdirSync(
      path.join(fixtureRoot, "infra/k8s/overlays/candidate-a/scheduler-worker"),
      { recursive: true }
    );
    for (const f of [
      "Dockerfile.poly",
      "Dockerfile.paper",
      "Dockerfile.echo",
      "Dockerfile.sw",
    ]) {
      writeFileSync(path.join(fixtureRoot, f), "FROM scratch\n");
    }
    writeFileSync(
      path.join(fixtureRoot, "infra/catalog/poly.yaml"),
      POLY_CATALOG
    );
    writeFileSync(
      path.join(fixtureRoot, "infra/catalog/scheduler-worker.yaml"),
      SW_CATALOG
    );
    writeFileSync(
      path.join(
        fixtureRoot,
        "infra/k8s/overlays/candidate-a/poly/kustomization.yaml"
      ),
      POLY_OVERLAY
    );
    writeFileSync(
      path.join(
        fixtureRoot,
        "infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml"
      ),
      SW_OVERLAY
    );
    const res = spawnSync("bash", [SCRIPT], {
      cwd: fixtureRoot,
      env: { ...process.env, OVERLAY_ENV: "candidate-a" },
      encoding: "utf-8",
    });
    expect(res.status, `script failed:\n${res.stderr}`).toBe(0);
    output = res.stdout;
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("SNAPSHOT_TSV_IS_3_COL", () => {
    const lines = output.trim().split("\n");
    for (const line of lines) {
      expect(line.split("\t")).toHaveLength(3);
    }
  });

  it("SNAPSHOT_HAS_ROW_PER_OVERLAY_IMAGE — poly emits 3 rows, scheduler-worker emits 1", () => {
    const lines = output.trim().split("\n");
    const polyRows = lines.filter((l) => l.startsWith("poly\t"));
    const swRows = lines.filter((l) => l.startsWith("scheduler-worker\t"));
    expect(polyRows).toHaveLength(3);
    expect(swRows).toHaveLength(1);
  });

  it("SNAPSHOT_PRESERVES_DIGEST_PINS", () => {
    expect(output).toContain(
      "poly\tghcr.io/cogni-dao/cogni-poly\tghcr.io/cogni-dao/cogni-poly@sha256:bae514810c27ce38d0602a560fe798f4037f0b033fb2362d4a53eabefc6e793d"
    );
    expect(output).toContain(
      "poly\tghcr.io/cogni-dao/poly-paper-sidecar\tghcr.io/cogni-dao/poly-paper-sidecar@sha256:e96106e8aae2478a8ee506d3f837024ac2e7a415b0cc6491bee6f4d9f541d014"
    );
  });

  it("SNAPSHOT_PRESERVES_TAG_PINS — quotes stripped from newTag values", () => {
    expect(output).toContain(
      "poly\tghcr.io/cogni-dao/poly-echo-sidecar\tghcr.io/cogni-dao/poly-echo-sidecar:candidate-a-placeholder-poly-echo-sidecar"
    );
    expect(output).not.toMatch(/:"[^"\n]+"/);
  });
});
