// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/classify-pr-build-state`
 * Purpose: Lock the 4-state classification contract of `classify-pr-build-state.sh` (ready | zero-affected | missing | no-run) via fixture-driven shape tests. Real GitHub API responses for the four states are pinned as JSON fixtures; the script is exercised against a local mock-gh shim so the test does not require network or a live workflow run.
 * Scope: Unit-level shape coverage of the classifier's output. Does NOT exercise the retry/sleep loop end-to-end (that's covered by the per-state mock returning a fixed status).
 * Invariants:
 *   - CLASSIFY_EMITS_ONE_OF_FOUR_STATES
 *   - CLASSIFY_NEVER_SILENT_GREEN_ON_MISSING_RUN
 *   - CLASSIFY_MATCHES_MATRIX_LEG_NAMES_NOT_PREFIX  (^build \(...\) only, not "build-manifest" / "build_x")
 * Side-effects: IO (mkdtemp + writes mock-gh shim + spawns bash; cleaned up per-test).
 * Links: scripts/ci/classify-pr-build-state.sh, .github/workflows/flight-preview.yml (caller), bug.5009.
 * @public
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/ci/classify-pr-build-state.sh");

type MockSpec = {
  // First call: /actions/workflows/pr-build.yml/runs?... → returns runs body
  runsBody: string;
  // Second call: /actions/runs/<id>/jobs?... → returns jobs body
  jobsBody?: string;
};

function setupMock(spec: MockSpec): { binDir: string; runDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "classify-mock-"));
  const binDir = path.join(root, "bin");
  const runDir = path.join(root, "run");
  // mkdir on demand
  spawnSync("mkdir", ["-p", binDir, runDir]);

  const runsFixture = path.join(runDir, "runs.json");
  const jobsFixture = path.join(runDir, "jobs.json");
  writeFileSync(runsFixture, spec.runsBody);
  if (spec.jobsBody !== undefined) {
    writeFileSync(jobsFixture, spec.jobsBody);
  }

  // mock-gh: route by URL substring.
  const mockGh = `#!/usr/bin/env bash
# Minimal gh CLI mock for classify-pr-build-state.sh tests.
# Routes 'gh api <url> --jq <expr>' to a fixture body filtered with python.
set -euo pipefail
url=""
jq_expr=""
prev=""
for arg in "$@"; do
  case "$prev" in
    api) url="$arg" ;;
    --jq) jq_expr="$arg" ;;
  esac
  prev="$arg"
done
case "$url" in
  *pr-build.yml/runs*) body_file="${runsFixture}" ;;
  *actions/runs/*/jobs*) body_file="${jobsFixture}" ;;
  *) echo "mock-gh: unhandled url: $url" >&2; exit 1 ;;
esac
if [ ! -f "$body_file" ]; then
  # Simulate empty response.
  echo ""
  exit 0
fi
if [ -n "$jq_expr" ]; then
  python3 -c "
import json, sys
expr = sys.argv[1]
body = json.load(open(sys.argv[2]))
# Translate the small subset of jq we use into Python.
if expr == '.workflow_runs[0] // empty':
    runs = body.get('workflow_runs') or []
    print(json.dumps(runs[0]) if runs else '')
elif expr.startswith('[.jobs[] | select(.name | test('):
    # Mirror: select jobs whose name matches '^build \\\\('
    import re
    pattern = re.compile(r'^build \\\\(')
    concls = sorted({
        j.get('conclusion', '')
        for j in body.get('jobs', [])
        if pattern.search(j.get('name', ''))
    })
    print(json.dumps(concls))
else:
    print(json.dumps(body))
" "$jq_expr" "$body_file"
else
  cat "$body_file"
fi
`;
  const ghPath = path.join(binDir, "gh");
  writeFileSync(ghPath, mockGh);
  chmodSync(ghPath, 0o755);
  return { binDir, runDir };
}

function runClassify(
  mock: { binDir: string },
  env: Record<string, string>
): ReturnType<typeof spawnSync> {
  const outFile = path.join(mock.binDir, "github-output");
  writeFileSync(outFile, "");
  return spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${mock.binDir}:${process.env.PATH ?? ""}`,
      CLASSIFY_RETRY_ATTEMPTS: "1",
      CLASSIFY_RETRY_SLEEP_S: "1",
      GITHUB_OUTPUT: outFile,
      ...env,
    },
    encoding: "utf-8",
  });
}

describe("classify-pr-build-state.sh", () => {
  let mock: { binDir: string; runDir: string } | null = null;

  afterEach(() => {
    if (mock) {
      rmSync(path.dirname(mock.binDir), { recursive: true, force: true });
      mock = null;
    }
  });

  it("READY — build matrix succeeded → state=ready", () => {
    mock = setupMock({
      runsBody: JSON.stringify({
        workflow_runs: [
          { id: 111, status: "completed", conclusion: "success" },
        ],
      }),
      jobsBody: JSON.stringify({
        jobs: [
          { name: "detect", conclusion: "success" },
          { name: "build (poly)", conclusion: "success" },
          { name: "build (poly-test-worker)", conclusion: "success" },
          { name: "manifest", conclusion: "success" },
        ],
      }),
    });
    const r = runClassify(mock, {
      PR_NUMBER: "100",
      HEAD_SHA: "a".repeat(40),
      REPOSITORY: "Cogni-DAO/cogni-poly",
      GH_TOKEN: "fake",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("state=ready");
  });

  it("ZERO_AFFECTED — empty matrix (no build jobs) → state=zero-affected", () => {
    mock = setupMock({
      runsBody: JSON.stringify({
        workflow_runs: [
          { id: 222, status: "completed", conclusion: "success" },
        ],
      }),
      jobsBody: JSON.stringify({
        jobs: [
          { name: "detect", conclusion: "success" },
          // No `build (...)` legs — matrix was empty.
          { name: "manifest", conclusion: "success" },
        ],
      }),
    });
    const r = runClassify(mock, {
      PR_NUMBER: "100",
      HEAD_SHA: "b".repeat(40),
      REPOSITORY: "Cogni-DAO/cogni-poly",
      GH_TOKEN: "fake",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("state=zero-affected");
  });

  it("MISSING — build matrix had a failed leg → state=missing", () => {
    mock = setupMock({
      runsBody: JSON.stringify({
        workflow_runs: [
          { id: 333, status: "completed", conclusion: "failure" },
        ],
      }),
      jobsBody: JSON.stringify({
        jobs: [
          { name: "build (poly)", conclusion: "failure" },
          { name: "build (poly-test-worker)", conclusion: "success" },
        ],
      }),
    });
    const r = runClassify(mock, {
      PR_NUMBER: "100",
      HEAD_SHA: "c".repeat(40),
      REPOSITORY: "Cogni-DAO/cogni-poly",
      GH_TOKEN: "fake",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("state=missing");
  });

  it("NO_RUN — no merge_group pr-build run for HEAD_SHA → state=no-run", () => {
    mock = setupMock({
      runsBody: JSON.stringify({ workflow_runs: [] }),
    });
    const r = runClassify(mock, {
      PR_NUMBER: "100",
      HEAD_SHA: "d".repeat(40),
      REPOSITORY: "Cogni-DAO/cogni-poly",
      GH_TOKEN: "fake",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("state=no-run");
  });

  it("MATCHES_MATRIX_LEGS_NOT_OTHERS — build-manifest does not get counted as a build leg", () => {
    mock = setupMock({
      runsBody: JSON.stringify({
        workflow_runs: [
          { id: 444, status: "completed", conclusion: "success" },
        ],
      }),
      jobsBody: JSON.stringify({
        jobs: [
          // Pre-existing pattern: a non-matrix job whose name starts with
          // "build". Must NOT be classified as a matrix leg.
          { name: "build-manifest", conclusion: "success" },
          { name: "detect", conclusion: "success" },
        ],
      }),
    });
    const r = runClassify(mock, {
      PR_NUMBER: "100",
      HEAD_SHA: "e".repeat(40),
      REPOSITORY: "Cogni-DAO/cogni-poly",
      GH_TOKEN: "fake",
    });
    expect(r.status, r.stderr).toBe(0);
    // With no `build (...)` legs, build-manifest must NOT be folded in:
    // classifier should treat this as zero-affected, not ready.
    expect(r.stdout).toContain("state=zero-affected");
  });
});
