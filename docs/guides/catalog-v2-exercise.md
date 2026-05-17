---
id: catalog-v2-exercise
type: guide
title: Catalog v2 — End-to-End Exercise
status: draft
trust: draft
summary: Single-PR exercise for a new dev — add a Shape B sidecar to the poly node, ride it through pr-build → candidate-flight → /validate-candidate → preview → production, then exercise the rollback path. Proves catalog v2's "one entry in images:[] = the whole pipeline works."
read_when: Onboarding to the cogni-poly CI/CD substrate, or sanity-checking that catalog v2 still delivers its outcome after any pipeline change.
owner: derekg1729
created: 2026-05-17
tags: [ci-cd, catalog, onboarding, exercise]
---

# Catalog v2 — End-to-End Exercise

## What this is

A scripted exercise for a new contributor to **prove the catalog v2 substrate end-to-end on their own**. You will add a small Shape B sidecar to the `poly` node, ship it through the entire pipeline (PR build → candidate-flight → `/validate-candidate` → merge → preview → production), then exercise the rollback path to remove it. The whole thing is one PR forward, one PR back.

This is not optional documentation reading. The exercise is **the only acceptance test** for the spec's outcome sentence: _"add a new image = one entry in images:[] + standard k8s manifests, zero script edits, zero workflow edits, full pipeline runs against it."_ If you complete this exercise and every gate goes green without you editing a single CI script or workflow file, catalog v2 works. If anything in the chain forces a script edit, that's a bug — file it.

**Prerequisites you must already have:**

- Forked + cloned `Cogni-DAO/cogni-poly` with a worktree set up per [`new-worktree-setup.md`](./new-worktree-setup.md).
- `pnpm install` clean.
- `gh auth status` green.
- Captured Playwright state for poly at `.local-auth/candidate-a-poly.storageState.json` per [`candidate-auth-bootstrap.md`](./candidate-auth-bootstrap.md). Required for `/validate-candidate`.
- Read [`catalog-v2.md`](../spec/catalog-v2.md) end-to-end first. Total context: ~10 minutes. Skip nothing.

---

## The exercise — add `poly-echo-sidecar`

A trivial 40-line Python sidecar that listens on port 9101 and answers `GET /echo?msg=...` with `{"echo": "<msg>", "buildSha": "<BUILD_SHA>", "ts": "<utc>"}`. Candidate-a + preview only (NOT production — same model as paper-sidecar).

### Step 0 — Branch off main

```bash
git fetch origin main
git checkout -b <yourname>/catalog-v2-exercise-echo-sidecar origin/main
```

### Step 1 — Author the sidecar source

```bash
mkdir -p nodes/poly/sidecars/echo
```

`nodes/poly/sidecars/echo/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS base
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}
WORKDIR /app
RUN pip install --no-cache-dir fastapi==0.115.0 uvicorn==0.32.0
COPY server.py /app/server.py
USER 1000
EXPOSE 9101
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9101"]

FROM base AS test
RUN pip install --no-cache-dir httpx==0.27.0 pytest==8.3.0
COPY tests/ /app/tests/
RUN python -m pytest -q /app/tests/
```

`nodes/poly/sidecars/echo/server.py`:

```python
import os
from datetime import datetime, timezone
from fastapi import FastAPI

app = FastAPI()
BUILD_SHA = os.getenv("BUILD_SHA", "unknown")

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.get("/echo")
def echo(msg: str = ""):
    return {"echo": msg, "buildSha": BUILD_SHA, "ts": datetime.now(timezone.utc).isoformat()}
```

`nodes/poly/sidecars/echo/tests/test_smoke.py`:

```python
from fastapi.testclient import TestClient
from server import app

client = TestClient(app)

def test_healthz():
    assert client.get("/healthz").json() == {"status": "ok"}

def test_echo():
    body = client.get("/echo?msg=hi").json()
    assert body["echo"] == "hi"
    assert "buildSha" in body and "ts" in body
```

`nodes/poly/sidecars/echo/AGENTS.md` — copy the shape from `nodes/poly/sidecars/paper-trader/AGENTS.md`, fill in the obvious fields.

### Step 2 — Add one entry to the poly catalog

Edit `infra/catalog/poly.yaml`. Add to `images:[]`:

```yaml
- name: poly-echo-sidecar
  role: sidecar
  dockerfile: nodes/poly/sidecars/echo/Dockerfile
  image_name: ghcr.io/cogni-dao/poly-echo-sidecar
  image_tag_suffix: ""
  path_prefix: nodes/poly/sidecars/echo/
  build:
    context: nodes/poly/sidecars/echo
    target: base
    test_target: test
    cache_scope: poly-echo-sidecar
```

That is the ONLY catalog edit. If you find yourself touching `scripts/ci/lib/image-tags.sh`, `promote-build-payload.sh`, `build-and-push-images.sh`, or any workflow file — STOP. That is the bug the exercise is designed to catch. File it, do not work around it.

### Step 3 — Add overlay entries (candidate-a + preview only)

Edit `infra/k8s/overlays/candidate-a/poly/kustomization.yaml` AND `infra/k8s/overlays/preview/poly/kustomization.yaml`. Add to the `images:` block:

```yaml
- name: ghcr.io/cogni-dao/poly-echo-sidecar
  newName: ghcr.io/cogni-dao/poly-echo-sidecar
  newTag: "candidate-a-placeholder-poly-echo-sidecar" # change "candidate-a" → "preview" in the other overlay
```

Add to the same overlay's `patches:` (one per overlay):

```yaml
- target:
    kind: Deployment
    name: node-app
  patch: |
    - op: add
      path: /spec/template/spec/containers/-
      value:
        name: poly-echo-sidecar
        image: ghcr.io/cogni-dao/poly-echo-sidecar
        ports:
          - containerPort: 9101
            name: echo
            protocol: TCP
        livenessProbe:
          httpGet: { path: /healthz, port: echo }
          initialDelaySeconds: 5
          periodSeconds: 30
        readinessProbe:
          httpGet: { path: /healthz, port: echo }
          initialDelaySeconds: 3
          periodSeconds: 10
        resources:
          requests: { memory: "64Mi", cpu: "20m" }
          limits:   { memory: "128Mi", cpu: "100m" }
```

**DO NOT** touch `infra/k8s/overlays/production/poly/kustomization.yaml`. The exercise deliberately omits the sidecar from production — proves `promote-k8s-image`'s exit-2 skip path.

### Step 4 — Local pre-flight

```bash
pnpm install                                         # picks up nothing new for sidecar
pnpm check:catalog                                   # 26+ invariants; new image must be valid
bash scripts/ci/tests/promote-build-payload.test.sh  # 4 regression cases must stay green
bash -c '. scripts/ci/lib/image-tags.sh && images_for_deploy_unit poly'
# Expected: poly poly-paper-sidecar poly-echo-sidecar
docker build -t local-echo --target test nodes/poly/sidecars/echo  # smoke gate
```

If `pnpm check:catalog` fails with "image.name not unique" or "(image_name, image_tag_suffix) collision" — fix the catalog entry, not the test.

### Step 5 — Open PR + watch CI

```bash
git add -A && git commit -m "feat(poly): exercise — add poly-echo-sidecar (catalog v2 e2e)"
git push -u origin HEAD
gh pr create --draft --base main --title "exercise: poly-echo-sidecar (catalog v2 e2e)" --body-file - <<'EOF'
Catalog v2 exercise PR — adds poly-echo-sidecar to prove the substrate end-to-end.
Forward path: candidate-flight → /validate-candidate → preview. Rollback PR follows.

## Validation checklist
- [ ] pr-build matrix shows 4 legs (poly, poly-migrator if any, poly-paper-sidecar, poly-echo-sidecar)
- [ ] candidate-flight green; deploy/candidate-a-poly carries 3 digests (poly, poly-paper-sidecar, poly-echo-sidecar)
- [ ] /validate-candidate scorecard PASS
- [ ] merge → flight-preview green; preview overlay carries 3 digests
- [ ] https://poly-preview.cognidao.org/version.buildSha matches merge SHA
- [ ] production-overlay deliberately omits the echo sidecar — verify promote-k8s-image returns exit-2 for it on prod promote
EOF
```

Wait for required checks (`unit / component / static / manifest`). Expect:

- `pr-build` matrix grows by one leg (`build (poly-echo-sidecar)`).
- `static` runs `pnpm check:catalog` and passes.
- `single-node-scope` will go RED (operator + poly cross-domain — catalog file in `infra/` is currently operator-classified pending the classifier extension). That's expected; it does not block merge.

### Step 6 — Candidate-flight

```bash
gh pr ready <N>
gh workflow run candidate-flight.yml -R Cogni-DAO/cogni-poly --ref <your-branch> -f pr_number=<N>
gh run watch <run-id>
```

Expected end state:

- `flight (candidate-a, poly)`: success — promote-build-payload writes 3 digests
- `flight (candidate-a, scheduler-worker)`: success
- `verify-candidate (candidate-a, poly)`: success
- `report-status`: success

Verify on the VM (read-only SSH per [`devops-expert SKILL.md`](../../.claude/skills/devops-expert/SKILL.md) policy):

```bash
ssh -i ~/dev/cogni-poly/.local/candidate-a-vm-key root@$(cat ~/dev/cogni-poly/.local/candidate-a-vm-ip) \
  "kubectl -n cogni-candidate-a get pod -l app.kubernetes.io/instance=poly -o jsonpath='{range .items[*].spec.containers[*]}{.name}: {.image}{\"\\n\"}{end}'"
```

Expected: `app`, `poly-paper-sidecar`, `poly-echo-sidecar` — all three at fresh `@sha256:` digests.

Exercise the new sidecar end-to-end:

```bash
ssh ... "kubectl -n cogni-candidate-a exec deploy/poly-node-app -c app -- curl -sS http://localhost:9101/echo?msg=catalog-v2-rocks"
```

Expected JSON: `{"echo":"catalog-v2-rocks","buildSha":"<your-pr-head-sha>","ts":"..."}`.

### Step 7 — `/validate-candidate`

```bash
/validate-candidate <N>
```

Expected scorecard PASS — at minimum, rows for: SIDECAR-DEPLOYED (echo), buildSha match, in-pod localhost echo call observed.

### Step 8 — Merge → preview

```bash
gh pr merge <N> --squash --auto    # enters merge queue
```

Watch:

- merge_group rebuild — `pr-build` re-runs with `mq-<N>-<queue-sha>-*` tags including `mq-<N>-<queue-sha>-poly-echo-sidecar` (NOTE: trailing suffix is empty because `image_tag_suffix: ""` AND the image lives in its own GHCR repo `ghcr.io/cogni-dao/poly-echo-sidecar`).
- push:main → `flight-preview` retags all 3 images.
- `promote-and-deploy` preview matrix runs poly + scheduler-worker.
- `verify-deploy (poly)` confirms preview `/version.buildSha` matches merge SHA.

Verify preview:

```bash
curl https://poly-preview.cognidao.org/version | jq .buildSha   # must match merge SHA
# in-pod echo
ssh -i ~/dev/cogni-poly/.local/preview-vm-key root@$(cat ~/dev/cogni-poly/.local/preview-vm-ip) \
  "kubectl -n cogni-preview exec deploy/poly-node-app -c app -- curl -sS http://localhost:9101/echo?msg=preview-rocks"
```

### Step 9 — Production promote (proves exit-2 skip)

```bash
gh workflow run promote-and-deploy.yml -R Cogni-DAO/cogni-poly --ref main \
  -f environment=production \
  -f source_sha=<merge-sha> -f build_sha=<merge-sha>
```

Watch the `promote-k8s (poly)` leg's log. In `promote-build-payload.sh`'s output you should see:

```
Promoting image 'poly' (ghcr.io/cogni-dao/cogni-poly) into production/poly overlay
[INFO] Updated infra/k8s/overlays/production/poly/kustomization.yaml
Promoting image 'poly-paper-sidecar' (ghcr.io/cogni-dao/poly-paper-sidecar) into production/poly overlay
[INFO] Updated ...
Promoting image 'poly-echo-sidecar' (ghcr.io/cogni-dao/poly-echo-sidecar) into production/poly overlay
NO_MATCH:ghcr.io/cogni-dao/poly-echo-sidecar
::notice::Overlay production/poly has no images[] entry for ghcr.io/cogni-dao/poly-echo-sidecar — intentional skip
Promoted images for poly: poly,poly-paper-sidecar
```

`promoted_apps=poly` (the deploy unit, not per-image — verify-buildsha keys on this). Production deploys successfully without the echo sidecar.

### Step 10 — Forward exercise complete

If every step above went green without you touching CI scripts, workflows, schema, or helper code, **catalog v2's outcome sentence holds**. Write a one-paragraph experience report in the PR body (or the rollback PR's body) — what surprised you, what felt fragile, what you'd improve.

---

## The rollback exercise

Same loop in reverse. Proves "remove an image" is also one-line + standard k8s edits.

### Rollback step 1 — Revert PR

```bash
git checkout -b <yourname>/catalog-v2-exercise-rollback origin/main
git revert <forward-merge-commit-sha> --no-edit
git push -u origin HEAD
gh pr create --base main --title "exercise: rollback poly-echo-sidecar" --body "Revert of #<N> per catalog-v2-exercise.md."
```

This single revert commit must:

- Drop the `poly-echo-sidecar` entry from `infra/catalog/poly.yaml`.
- Drop its `images:` + container patch from both overlays (candidate-a + preview).
- Drop `nodes/poly/sidecars/echo/`.

Required checks must pass. `pr-build` matrix shrinks back to 3 legs (poly, poly-paper-sidecar, scheduler-worker).

### Rollback step 2 — Candidate-flight the revert

```bash
gh workflow run candidate-flight.yml -R Cogni-DAO/cogni-poly --ref <rollback-branch> -f pr_number=<N+1>
```

Expected: the echo sidecar's overlay entry is gone post-rsync; `promote-build-payload` no longer iterates it (catalog drove it out); the pod restarts with 2 containers.

Verify:

```bash
ssh ... "kubectl -n cogni-candidate-a get pod -l app.kubernetes.io/instance=poly -o jsonpath='{range .items[*].spec.containers[*]}{.name}{\"\\n\"}{end}'"
```

Expected: `app`, `poly-paper-sidecar` only.

`/validate-candidate <N+1>` against the rollback PR — confirm no echo logs in Loki at the new SHA, /version.buildSha matches.

### Rollback step 3 — Merge → preview → prod

```bash
gh pr merge <N+1> --squash --auto
```

flight-preview + promote-and-deploy preview chains run as in the forward case. After preview soak, dispatch production promote. The echo sidecar's GHCR images become garbage-collectable (no overlay references them); leave them — GHCR retention handles it.

### Rollback step 4 — Verify clean state

After production rollback completes:

- `git log --oneline -5` — forward + revert commits both present; no orphan files.
- `pnpm check:catalog` — 26 invariants pass.
- `images_for_deploy_unit poly` — returns `poly poly-paper-sidecar` only.
- Production poly pod — runs `app` only (paper-sidecar absent from production by design).
- Preview poly pod — runs `app` + `poly-paper-sidecar` only (echo gone).

---

## What this exercise validates

| Catalog v2 invariant                      | Forward proof                                                                                                                            | Rollback proof                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `ONE_CATALOG_FILE_IS_ONE_DEPLOY_UNIT`     | Adding echo did NOT add a catalog file — added entry to existing                                                                         | Removing echo did NOT remove the catalog file                 |
| `DEPLOY_UNIT_OWNS_ITS_IMAGES`             | echo rode poly's deploy branch + overlay; never got its own                                                                              | echo left poly's images[] without leaving an orphan elsewhere |
| `IMAGE_TRIGGERS_INHERIT_DEPLOY_UNIT_PATH` | echo's `path_prefix: nodes/poly/sidecars/echo/` triggered only its image in `detect-affected`                                            | Path removal stopped triggering builds                        |
| `SCHEMA_VALIDATION_GATES_MERGE`           | `pnpm check:catalog` would reject duplicate `image_name` / missing `role:app` / dockerfile-not-on-disk                                   | Same on rollback                                              |
| `BUILD_ONCE_PROMOTE_DIGEST`               | Same `@sha256:` rode candidate-a → preview (and would ride preview-forward to prod were echo in prod overlay)                            | n/a                                                           |
| `SCRIPTS_ARE_THE_API`                     | Zero script edits during exercise — if you needed any, that's the bug                                                                    | Zero script edits during rollback                             |
| exit-2 legitimate-skip                    | promote-k8s-image returned exit-2 for echo on production overlay (no `images[]` entry); promoted_apps still reflects the apps that wrote | n/a                                                           |

If any row above fails, the substrate has a real gap. File it as a `bug.*` work item against `Cogni-DAO/cogni-poly` linking this guide.

## Cost

| Item         | Cost                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| GHCR storage | ~30 MB (echo image + smoke layer) — orphaned after rollback, GHCR retention handles it                                               |
| Compute      | 4 pr-build legs (forward) + 4 (queue) + 4 (rollback) = ~12 GHA runner-minutes                                                        |
| Cluster      | 1 extra container in candidate-a + preview pods for the duration of the exercise (~30 min real time if you don't pause) — negligible |
| Human time   | 45-90 min depending on familiarity                                                                                                   |

## When this exercise should re-run

After any of the following:

- Any change to `scripts/ci/lib/image-tags.sh`.
- Any change to `promote-build-payload.sh`, `promote-k8s-image.sh`, `build-and-push-images.sh`, `resolve-pr-build-images.sh`, `build-promote-payload.sh`, `detect-affected.sh`.
- Any change to `pr-build.yml`, `candidate-flight.yml`, `flight-preview.yml`, `promote-and-deploy.yml` matrix shapes.
- Schema bump in `infra/catalog/_schema.json`.
- The classifier extension (when `tests/ci-invariants/classify.ts` learns about per-node catalog files + overlays — `single-node-scope` will stop going red on this PR; re-running proves the classifier didn't regress catalog-v2 behavior).

## Related

- [`docs/spec/catalog-v2.md`](../spec/catalog-v2.md) — design + invariants
- [`docs/spec/ci-cd.md`](../spec/ci-cd.md) — full pipeline axioms, especially axiom 16 (`CATALOG_IS_SSOT`)
- [`docs/spec/node-ci-cd-contract.md`](../spec/node-ci-cd-contract.md) — § Node-autonomous service evolution
- [`docs/guides/create-service.md`](./create-service.md) — Shape A / Shape B playbook
- [`.claude/skills/validate-candidate/SKILL.md`](../../.claude/skills/validate-candidate/SKILL.md) — scorecard format used in step 7
