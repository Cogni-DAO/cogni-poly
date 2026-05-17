// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/restore-overlay-from-snapshot`
 * Purpose: End-to-end verification of the candidate-flight restore-then-promote interaction. Exercises the full sequence (snapshot → simulated rsync clobber → restore → promote with a partial-affected-only payload) and asserts the final overlay matches the desired state for catalog v2 multi-image deploy units (Shape B sidecars).
 * Scope: Spawns `bash` against tmpdir fixtures. Does not call git, docker, kubectl,
 *        or network. Tests the actual scripts that ship in candidate-flight.yml.
 * Invariants:
 *   - RESTORE_REPLAYS_DIGEST_PINS
 *   - RESTORE_SKIPS_TAG_PINS              (placeholders stay placeholders so
 *                                          promote can write a real digest)
 *   - PARTIAL_AFFECTED_PR_KEEPS_SIBLINGS  (PR touching one image of a multi-
 *                                          image unit leaves sibling images on
 *                                          their prior digest — the bug class
 *                                          that bug.5004's symptom-cascade hid)
 *   - REMOVED_IMAGE_IS_NOOP               (snapshot row whose image was removed
 *                                          from the overlay → promote-k8s rc=2 →
 *                                          restore script exits 0, no phantom
 *                                          entry resurrection)
 *   - COLD_START_IS_NOOP                  (empty snapshot file → exit 0, no error)
 * Side-effects: IO (mkdtemp + writes fixture files + spawns bash; cleaned up per-test)
 * Links: scripts/ci/restore-overlay-from-snapshot.sh,
 *        scripts/ci/snapshot-overlay-digests.sh,
 *        scripts/ci/promote-k8s-image.sh,
 *        .github/workflows/candidate-flight.yml (restore step)
 * @public
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SNAPSHOT_SCRIPT = path.join(
  REPO_ROOT,
  "scripts/ci/snapshot-overlay-digests.sh"
);
const RESTORE_SCRIPT = path.join(
  REPO_ROOT,
  "scripts/ci/restore-overlay-from-snapshot.sh"
);
const PROMOTE_SCRIPT = path.join(REPO_ROOT, "scripts/ci/promote-k8s-image.sh");

const DIGEST_POLY_LIVE =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_PAPER_LIVE =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const DIGEST_ECHO_LIVE =
  "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const DIGEST_PAPER_PR_NEW =
  "sha256:aaaa222222222222222222222222222222222222222222222222222222222222";

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

function overlayYaml(opts: {
  polyRef: { kind: "digest"; value: string } | { kind: "tag"; value: string };
  paperRef: { kind: "digest"; value: string } | { kind: "tag"; value: string };
  echoRef: { kind: "digest"; value: string } | { kind: "tag"; value: string };
}): string {
  const ref = (
    name: string,
    r: { kind: "digest"; value: string } | { kind: "tag"; value: string }
  ): string =>
    r.kind === "digest"
      ? `  - name: ${name}\n    newName: ${name}\n    digest: "${r.value}"\n`
      : `  - name: ${name}\n    newName: ${name}\n    newTag: "${r.value}"\n`;
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: cogni-candidate-a

resources:
  - ../../../base/node-app

namePrefix: poly-

images:
${ref("ghcr.io/cogni-dao/cogni-poly", opts.polyRef)}${ref(
  "ghcr.io/cogni-dao/poly-paper-sidecar",
  opts.paperRef
)}${ref("ghcr.io/cogni-dao/poly-echo-sidecar", opts.echoRef)}`;
}

function setupFixture(): { root: string; overlayPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), "restore-overlay-"));
  mkdirSync(path.join(root, "infra/catalog"), { recursive: true });
  mkdirSync(path.join(root, "infra/k8s/overlays/candidate-a/poly"), {
    recursive: true,
  });
  for (const f of ["Dockerfile.poly", "Dockerfile.paper", "Dockerfile.echo"]) {
    writeFileSync(path.join(root, f), "FROM scratch\n");
  }
  writeFileSync(path.join(root, "infra/catalog/poly.yaml"), POLY_CATALOG);
  const overlayPath = path.join(
    root,
    "infra/k8s/overlays/candidate-a/poly/kustomization.yaml"
  );
  return { root, overlayPath };
}

function digestOfImage(overlay: string, imageName: string): string | null {
  const lines = overlay.split("\n");
  const idx = lines.findIndex((l) => l.includes(`name: ${imageName}`));
  if (idx === -1) return null;
  for (let i = idx + 1; i < Math.min(idx + 6, lines.length); i++) {
    const m = lines[i].match(/digest:\s*"?(sha256:[0-9a-f]+)"?/);
    if (m) return m[1];
    if (/^\s*- /.test(lines[i])) break;
  }
  return null;
}

function tagOfImage(overlay: string, imageName: string): string | null {
  const lines = overlay.split("\n");
  const idx = lines.findIndex((l) => l.includes(`name: ${imageName}`));
  if (idx === -1) return null;
  for (let i = idx + 1; i < Math.min(idx + 6, lines.length); i++) {
    const m = lines[i].match(/newTag:\s*"?([^"\n]+?)"?\s*$/);
    if (m) return m[1].trim();
    if (/^\s*- /.test(lines[i])) break;
  }
  return null;
}

describe("restore-then-promote end-to-end (catalog v2 multi-image)", () => {
  let fixture: { root: string; overlayPath: string };

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("PARTIAL_AFFECTED_PR_KEEPS_SIBLINGS — paper-only PR leaves echo on prior digest, not placeholder", () => {
    // Pre-flight overlay state (what deploy-branch had — all 3 real digests).
    writeFileSync(
      fixture.overlayPath,
      overlayYaml({
        polyRef: { kind: "digest", value: DIGEST_POLY_LIVE },
        paperRef: { kind: "digest", value: DIGEST_PAPER_LIVE },
        echoRef: { kind: "digest", value: DIGEST_ECHO_LIVE },
      })
    );

    // 1. Snapshot pre-rsync.
    const snapshotFile = path.join(fixture.root, "snapshot.tsv");
    const snapRes = spawnSync("bash", [SNAPSHOT_SCRIPT], {
      cwd: fixture.root,
      env: { ...process.env, OVERLAY_ENV: "candidate-a" },
      encoding: "utf-8",
    });
    expect(snapRes.status, snapRes.stderr).toBe(0);
    writeFileSync(snapshotFile, snapRes.stdout);
    expect(snapRes.stdout.split("\n").filter(Boolean)).toHaveLength(3);

    // 2. Simulate rsync-from-main: main's overlay has echo as a placeholder
    //    newTag (the real-world scenario — main never promotes echo).
    writeFileSync(
      fixture.overlayPath,
      overlayYaml({
        polyRef: { kind: "digest", value: DIGEST_POLY_LIVE },
        paperRef: { kind: "digest", value: DIGEST_PAPER_LIVE },
        echoRef: {
          kind: "tag",
          value: "candidate-a-placeholder-poly-echo-sidecar",
        },
      })
    );

    // 3. Restore from snapshot (the script under test).
    const restoreRes = spawnSync("bash", [RESTORE_SCRIPT], {
      cwd: fixture.root,
      env: {
        ...process.env,
        SNAPSHOT_FILE: snapshotFile,
        OVERLAY_ENV: "candidate-a",
        PROMOTE_SCRIPT,
      },
      encoding: "utf-8",
    });
    expect(restoreRes.status, restoreRes.stderr).toBe(0);

    // 4. Promote (paper-sidecar only, as a PR #73-style affected-only flight).
    const promoteRes = spawnSync(
      "bash",
      [
        PROMOTE_SCRIPT,
        "--no-commit",
        "--env",
        "candidate-a",
        "--app",
        "poly",
        "--image-name",
        "ghcr.io/cogni-dao/poly-paper-sidecar",
        "--digest",
        `ghcr.io/cogni-dao/poly-paper-sidecar@${DIGEST_PAPER_PR_NEW}`,
      ],
      { cwd: fixture.root, encoding: "utf-8" }
    );
    expect(promoteRes.status, promoteRes.stderr).toBe(0);

    // 5. Final overlay must have: poly=live (from snapshot/rsync), paper=PR
    //    new digest, echo=live (restored — NOT placeholder).
    const finalOverlay = readFileSync(fixture.overlayPath, "utf-8");
    expect(digestOfImage(finalOverlay, "ghcr.io/cogni-dao/cogni-poly")).toBe(
      DIGEST_POLY_LIVE
    );
    expect(
      digestOfImage(finalOverlay, "ghcr.io/cogni-dao/poly-paper-sidecar")
    ).toBe(DIGEST_PAPER_PR_NEW);
    expect(
      digestOfImage(finalOverlay, "ghcr.io/cogni-dao/poly-echo-sidecar")
    ).toBe(DIGEST_ECHO_LIVE);
    expect(
      tagOfImage(finalOverlay, "ghcr.io/cogni-dao/poly-echo-sidecar")
    ).toBeNull();
  });

  it("RESTORE_SKIPS_TAG_PINS — snapshot rows with placeholder newTags don't overwrite the rsync'd state", () => {
    // Snapshot captures a placeholder for echo (cold-start scenario where
    // echo was never deployed yet).
    writeFileSync(
      fixture.overlayPath,
      overlayYaml({
        polyRef: { kind: "digest", value: DIGEST_POLY_LIVE },
        paperRef: { kind: "digest", value: DIGEST_PAPER_LIVE },
        echoRef: {
          kind: "tag",
          value: "candidate-a-placeholder-poly-echo-sidecar",
        },
      })
    );
    const snapshotFile = path.join(fixture.root, "snapshot.tsv");
    const snapRes = spawnSync("bash", [SNAPSHOT_SCRIPT], {
      cwd: fixture.root,
      env: { ...process.env, OVERLAY_ENV: "candidate-a" },
      encoding: "utf-8",
    });
    writeFileSync(snapshotFile, snapRes.stdout);

    // Rsync brings a digest for echo (post-promotion main).
    writeFileSync(
      fixture.overlayPath,
      overlayYaml({
        polyRef: { kind: "digest", value: DIGEST_POLY_LIVE },
        paperRef: { kind: "digest", value: DIGEST_PAPER_LIVE },
        echoRef: { kind: "digest", value: DIGEST_ECHO_LIVE },
      })
    );

    const restoreRes = spawnSync("bash", [RESTORE_SCRIPT], {
      cwd: fixture.root,
      env: {
        ...process.env,
        SNAPSHOT_FILE: snapshotFile,
        OVERLAY_ENV: "candidate-a",
        PROMOTE_SCRIPT,
      },
      encoding: "utf-8",
    });
    expect(restoreRes.status, restoreRes.stderr).toBe(0);

    // Echo must retain the rsync'd digest, not regress to the snapshot's
    // placeholder tag.
    const finalOverlay = readFileSync(fixture.overlayPath, "utf-8");
    expect(
      digestOfImage(finalOverlay, "ghcr.io/cogni-dao/poly-echo-sidecar")
    ).toBe(DIGEST_ECHO_LIVE);
  });

  it("REMOVED_IMAGE_IS_NOOP — snapshot row for an image no longer in the overlay does not fail the restore", () => {
    // Pre-flight: overlay had all 3 images (snapshot captures all 3).
    writeFileSync(
      fixture.overlayPath,
      overlayYaml({
        polyRef: { kind: "digest", value: DIGEST_POLY_LIVE },
        paperRef: { kind: "digest", value: DIGEST_PAPER_LIVE },
        echoRef: { kind: "digest", value: DIGEST_ECHO_LIVE },
      })
    );
    const snapshotFile = path.join(fixture.root, "snapshot.tsv");
    const snapRes = spawnSync("bash", [SNAPSHOT_SCRIPT], {
      cwd: fixture.root,
      env: { ...process.env, OVERLAY_ENV: "candidate-a" },
      encoding: "utf-8",
    });
    expect(snapRes.status, snapRes.stderr).toBe(0);
    writeFileSync(snapshotFile, snapRes.stdout);

    // Rsync brings in main's overlay where echo has been removed entirely
    // (e.g. cleanup PR). Write an overlay that lacks the echo entry.
    writeFileSync(
      fixture.overlayPath,
      `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: cogni-candidate-a

resources:
  - ../../../base/node-app

namePrefix: poly-

images:
  - name: ghcr.io/cogni-dao/cogni-poly
    newName: ghcr.io/cogni-dao/cogni-poly
    digest: "${DIGEST_POLY_LIVE}"
  - name: ghcr.io/cogni-dao/poly-paper-sidecar
    newName: ghcr.io/cogni-dao/poly-paper-sidecar
    digest: "${DIGEST_PAPER_LIVE}"
`
    );

    const restoreRes = spawnSync("bash", [RESTORE_SCRIPT], {
      cwd: fixture.root,
      env: {
        ...process.env,
        SNAPSHOT_FILE: snapshotFile,
        OVERLAY_ENV: "candidate-a",
        PROMOTE_SCRIPT,
      },
      encoding: "utf-8",
    });
    expect(restoreRes.status, restoreRes.stderr).toBe(0);

    // Final overlay: poly + paper restored, echo absent (not resurrected).
    const finalOverlay = readFileSync(fixture.overlayPath, "utf-8");
    expect(digestOfImage(finalOverlay, "ghcr.io/cogni-dao/cogni-poly")).toBe(
      DIGEST_POLY_LIVE
    );
    expect(
      digestOfImage(finalOverlay, "ghcr.io/cogni-dao/poly-paper-sidecar")
    ).toBe(DIGEST_PAPER_LIVE);
    expect(
      digestOfImage(finalOverlay, "ghcr.io/cogni-dao/poly-echo-sidecar")
    ).toBeNull();
    expect(finalOverlay).not.toContain("poly-echo-sidecar");
  });

  it("COLD_START_IS_NOOP — empty snapshot file exits 0 without error", () => {
    const snapshotFile = path.join(fixture.root, "empty.tsv");
    writeFileSync(snapshotFile, "");
    const restoreRes = spawnSync("bash", [RESTORE_SCRIPT], {
      cwd: fixture.root,
      env: {
        ...process.env,
        SNAPSHOT_FILE: snapshotFile,
        OVERLAY_ENV: "candidate-a",
        PROMOTE_SCRIPT,
      },
      encoding: "utf-8",
    });
    expect(restoreRes.status, restoreRes.stderr).toBe(0);
  });
});
