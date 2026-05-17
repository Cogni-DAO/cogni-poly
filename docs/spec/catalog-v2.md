---
id: spec.catalog-v2
type: spec
title: Catalog v2 — separate deploy units from build units
status: draft
spec_state: draft
trust: draft
summary: Refactor infra/catalog/<name>.yaml to nest images[] under each catalog entry. One catalog file = one deploy unit (Argo Application + deploy branches); each unit owns N build units (images). Collapses today's "Shape 1 vs Shape 2" sidecar dichotomy, kills the hardcoded target lists in promote-build-payload.sh, and makes new images drop-in.
read_when: Adding a new node, service, sidecar, MCP, or migrator image; reviewing infra/catalog/_schema.json; touching detect-affected.sh / promote-build-payload.sh / image-tags.sh; planning the upstream sync to Cogni-DAO/cogni.
owner: derekg1729
created: 2026-05-16
tags: [ci-cd, catalog, deployment]
---

# Catalog v2 — separate deploy units from build units

## Context

Today's `infra/catalog/<name>.yaml` conflates two concerns:

1. **Deploy unit** — Argo Application + per-env deploy branch + public URL + path_prefix for affected-scope.
2. **Build unit** — Dockerfile + image-tag suffix + (optional) migrator image.

Each catalog row is "one image = one Argo app". That works for top-level node apps and standalone services, but breaks the moment a unit needs more than one image:

- **Per-node migrator** is hand-stitched via `migrator_tag_suffix` + an implicit second build leg — there's no first-class `images` declaration.
- **Sidecars** (paper-trading sibling container, future polymarket-niche helpers) need their own image but share the parent node's lifecycle. The current catalog can't model "image, no deploy branch" → [`docs/guides/create-service.md`](../guides/create-service.md) introduced "Shape 2" as a carve-out with its own build workflow, manual overlay digest edits, and a digest-only-not-newTag workaround for the [`promote-k8s-image.sh:77`](../../scripts/ci/promote-k8s-image.sh) first-`newTag:`-wins bug.

Symptoms today:

- [`scripts/ci/promote-build-payload.sh:115,152-155`](../../scripts/ci/promote-build-payload.sh) hardcodes `operator | poly | resy | scheduler-worker`. Add a new target with any other name → `detect-affected` lights it up, `pr-build` builds it, `promote-build-payload` silently drops it (`*) return 0`). bug.5004 in the cogni-poly tracker.
- Sidecars (Shape 2) get a parallel pipeline: their own `build-<name>.yml` workflow, their own image-name namespace under `infra/images/<name>/`, and a manual digest-bump dance documented in the create-service guide.
- Adding a new "thing" requires reading a 5-shape decision tree before the contributor knows where their Dockerfile lives.

The catalog is already the declared single source of truth ([`docs/spec/ci-cd.md`](./ci-cd.md) axiom 16, `CATALOG_IS_SSOT`). Catalog v2 lives that axiom: every image the repo ships is declared in the catalog; every deploy unit declares which images it owns.

## Goal

A repo where "add a new image" — whether it's a top-level node, a service, a sidecar, a per-node migrator, or a future polymarket-niche helper — is exactly one of:

- **(a)** add an entry to an existing catalog file's `images:` array, or
- **(b)** add a new catalog file with its own `deploy:` + `images:` blocks.

…and the full build → tag → promote → verify chain runs against the new image with zero script edits, zero workflow edits, and zero parallel workflow files.

## Non-Goals

- **AppSet generator glob (bug.5005)** — orthogonal cleanup that v2 enables but doesn't require. Filed separately.
- **Scaffolder (`pnpm new:node`)** — Backstage-style template generator. Closes the create-service guide to zero manual steps. Follow-up after v2 lands.
- **Schema versioning across multiple v\* coexistence** — v2 is a hard cutover, not a v1/v2 feature flag. Single migration PR per repo. Forward-only.
- **External-repo catalog federation** — out of scope; each repo's catalog is its own truth.

## Core Invariants

The same invariants that hold today, plus three new ones v2 introduces.

1. **`CATALOG_IS_SSOT`** (existing, [`ci-cd.md` axiom 16](./ci-cd.md)). Strengthened — every image in the repo is declared in catalog; no script hardcodes image-name lists.

2. **`ONE_CATALOG_FILE_IS_ONE_DEPLOY_UNIT`** (new). A catalog file maps 1:1 to an Argo Application + per-env deploy-branch triple. Adding a deploy unit = new catalog file. Adding an image to an existing deploy unit = new `images[]` entry in the same file.

3. **`DEPLOY_UNIT_OWNS_ITS_IMAGES`** (new). Every image rides exactly one deploy unit's `images:` array. Sidecars are images of their host node, not separate deploy units. Migrators are images of the node they migrate. There is no global "image registry" outside the catalog.

4. **`IMAGE_TRIGGERS_INHERIT_DEPLOY_UNIT_PATH`** (new). An image's `detect-affected` trigger defaults to its parent deploy unit's `path_prefix`. Per-image override is allowed (sidecars typically need a tighter prefix). Inheritance keeps the common case zero-config.

5. **`SCHEMA_VALIDATION_GATES_MERGE`** (new). `pnpm check:catalog` runs `ajv` (or equivalent) against `infra/catalog/_schema.json` on every PR and blocks merge on schema violation. Closes the gap where today's `_schema.json` is decorative.

6. **All existing CI/CD contract invariants** ([`node-ci-cd-contract.md`](./node-ci-cd-contract.md)) hold:
   - `SCRIPTS_ARE_THE_API` — workflows iterate from script-emitted JSON.
   - `BUILD_ONCE_PROMOTE_DIGEST` — unchanged.
   - `POLICY_STAYS_LOCAL` — catalog is per-repo, not centralized.
   - `SINGLE_RESPONSIBILITY` — workflow shapes preserved.
   - `FORK_FREEDOM` — no new secrets.
   - `SINGLE_DOMAIN_HARD_FAIL` — the v2 migration itself must be sequenced into multiple PRs. See § Migration Plan.

## Design

### Schema (v2)

```yaml
# Top-level keys describe the deploy unit.
name: poly # 1:1 with filename; ^[a-z][a-z0-9-]*$
type: node | service # node ⇒ requires node_id; service ⇒ no node_id
node_id: "<uuid>" # required when type=node
schema_version: 2 # NEW — required; loader rejects v1 with migration error

deploy: # how this unit lands in the cluster
  candidate_a_branch: deploy/candidate-a-<name>
  preview_branch: deploy/preview-<name>
  production_branch: deploy/production-<name>
  path_prefix: <repo-relative path>/ # default trigger prefix for owned images
  public_url: # optional; omit for services with no Ingress
    candidate-a: https://...
    preview: https://...
    production: https://...

images: # ≥1 entry; what to build for this unit
  - name: <image-id> # unique within repo; used as map key everywhere
    dockerfile: <repo-relative path to Dockerfile>
    image_tag_suffix: "-<image-id>" # GHCR tag suffix; empty allowed for historical operator
    path_prefix: <override> # optional; default = parent deploy.path_prefix
    role: app | migrator | sidecar # NEW — typing hint, drives overlay-block placement
```

**Field semantics**

- `images[].role`:
  - `app` — the primary runtime image; deploy unit must have exactly one.
  - `migrator` — runs as initContainer; deploy unit may have zero or one.
  - `sidecar` — sibling container in the app's pod; zero or more.
  - Drives `promote-build-payload.sh`'s overlay-block placement (which `images:` slot in the kustomization YAML it writes to). Replaces today's first-`newTag:`-wins fragility with explicit role typing.
- `image_tag_suffix` is repo-unique. The validator asserts uniqueness across all catalog files at PR time.
- `dockerfile` paths under `nodes/<X>/` make the image node-owned per [`node-ci-cd-contract.md`](./node-ci-cd-contract.md) — natural place for sidecars (`nodes/poly/sidecars/<name>/Dockerfile`).
- `deploy.public_url` is unchanged from [bug.5002](./ci-cd.md). Just nested under `deploy:` now for consistency.

### Worked example — poly with main app + migrator + paper-sidecar

```yaml
# infra/catalog/poly.yaml
name: poly
type: node
node_id: "5ed2d64f-2745-4676-983b-2fb7e05b2eba"
schema_version: 2

deploy:
  candidate_a_branch: deploy/candidate-a-poly
  preview_branch: deploy/preview-poly
  production_branch: deploy/production-poly
  path_prefix: nodes/poly/
  public_url:
    candidate-a: https://poly-test.cognidao.org
    preview: https://poly-preview.cognidao.org
    production: https://poly.cognidao.org

images:
  - name: poly
    role: app
    dockerfile: nodes/poly/app/Dockerfile
    image_tag_suffix: "-poly"
    path_prefix: nodes/poly/app/

  - name: poly-migrator
    role: migrator
    dockerfile: nodes/poly/db/Dockerfile
    image_tag_suffix: "-poly-migrate"
    path_prefix: nodes/poly/db/

  - name: poly-paper-sidecar
    role: sidecar
    dockerfile: nodes/poly/sidecars/paper-trader/Dockerfile
    image_tag_suffix: "-poly-paper-sidecar"
    path_prefix: nodes/poly/sidecars/paper-trader/
```

`scheduler-worker.yaml` collapses to:

```yaml
name: scheduler-worker
type: service
schema_version: 2

deploy:
  candidate_a_branch: deploy/candidate-a-scheduler-worker
  preview_branch: deploy/preview-scheduler-worker
  production_branch: deploy/production-scheduler-worker
  path_prefix: services/scheduler-worker/
  # no public_url — no Ingress

images:
  - name: scheduler-worker
    role: app
    dockerfile: services/scheduler-worker/Dockerfile
    image_tag_suffix: "-scheduler-worker"
```

### Script behavior

#### `scripts/ci/lib/image-tags.sh`

New helpers, all derived from catalog at source time:

| Helper                                      | Returns                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `all_images`                                | flat array of every image's `name` across all catalog files        |
| `deploy_units_with_node_apps`               | catalog files of type `node` (replaces today's `NODE_TARGETS`)     |
| `images_for_deploy_unit <name>`             | array of image names owned by that catalog file                    |
| `deploy_unit_for_image <image>`             | parent catalog file's `name` (reverse lookup)                      |
| `dockerfile_for_image <image>`              | `dockerfile` path                                                  |
| `image_tag_suffix_for_image <image>`        | tag suffix                                                         |
| `path_prefix_for_image <image>`             | image-level `path_prefix` if set, else parent `deploy.path_prefix` |
| `role_for_image <image>`                    | `app` / `migrator` / `sidecar`                                     |
| `public_url_for_target <env> <deploy-unit>` | unchanged from bug.5002, now reads `deploy.public_url`             |

Backwards-compat helpers (`ALL_TARGETS`, `NODE_TARGETS`, `tag_suffix_for_target`) are removed in the v2 PR. Callers update in the same PR.

#### `scripts/ci/detect-affected.sh`

- Iterates `all_images` (flat).
- For each image, matches changed paths against `path_prefix_for_image`.
- Output JSON gains a `deploy_unit` field per affected image, so downstream matrix jobs know which catalog file each image belongs to.
- Global-build-input rules (workflow file changes, lockfile changes, etc.) still trigger the full image set.

#### `scripts/ci/promote-build-payload.sh`

- Replaces hardcoded `promote_target operator/poly/resy/scheduler-worker` with `for image in $(images_for_deploy_unit "$NODE"); do promote_image_into_overlay "$image"; done`.
- Drops the `case "$target" in operator|poly|resy|scheduler-worker)` guard — no longer needed.
- `promote_image_into_overlay` reads the image's `role` and writes to the appropriate slot in the deploy unit's overlay's `images:` block. Removes the first-`newTag:`-wins workaround from [`create-service.md` Shape 2](../guides/create-service.md).

#### `scripts/ci/resolve-pr-build-images.sh`

- Iterates `all_images`, builds the payload JSON keyed by image name. Schema unchanged downstream.

#### `pr-build.yml` matrix

- Reads `targets_json` from `detect-affected` (same as today). The shape stays `[<image-name>, ...]`; what's different is that `<image-name>` is now any catalog-declared image, not just a top-level catalog entry.

### Schema validation

New gate `pnpm check:catalog`:

```bash
pnpm exec ajv validate \
  --spec=draft2020 \
  -s infra/catalog/_schema.json \
  -d "infra/catalog/*.yaml" \
  --strict=true \
  --all-errors
```

Wired into `pnpm check` (local) and the `static` CI job (merge gate). Closes the gap where today's schema is decorative.

Additional invariant tests in `tests/ci-invariants/`:

- Every `image_tag_suffix` is unique across all catalog files.
- Every `image.name` is unique across all catalog files.
- Every `deploy_unit` has exactly one image with `role: app`.
- Every `dockerfile` path resolves to an existing file.
- Every per-env `deploy.public_url` is `https://`.

These are pure file-IO checks — no infra required, run in the existing `unit` job.

### File reorganization

Sidecar Dockerfiles move from `infra/images/<name>/` to `nodes/<node>/sidecars/<name>/`:

| Before                                       | After                                         |
| -------------------------------------------- | --------------------------------------------- |
| `infra/images/poly-paper-sidecar/Dockerfile` | `nodes/poly/sidecars/paper-trader/Dockerfile` |
| `infra/images/poly-paper-sidecar/server.py`  | `nodes/poly/sidecars/paper-trader/server.py`  |
| `infra/images/poly-paper-sidecar/AGENTS.md`  | `nodes/poly/sidecars/paper-trader/AGENTS.md`  |
| `infra/images/poly-paper-sidecar/tests/`     | `nodes/poly/sidecars/paper-trader/tests/`     |

`infra/images/` shrinks to its proper scope: wrappers around upstream third-party images we don't author (currently just `litellm`).

The separate `.github/workflows/build-poly-paper-sidecar.yml` is **deleted**. `pr-build.yml`'s matrix builds the sidecar via the catalog entry like any other image.

### Overlay kustomization unchanged shape

`infra/k8s/overlays/<env>/<deploy-unit>/kustomization.yaml`'s `images:` block stays the same shape it has today (one entry per referenced image). What changes is who writes which entry:

- `promote-build-payload.sh` writes `role: app` and `role: migrator` digests via [`promote-k8s-image.sh`](../../scripts/ci/promote-k8s-image.sh).
- `promote-build-payload.sh` ALSO writes `role: sidecar` digests, using the image's `name` as the lookup key in the `images:` block. No more "edit the digest by hand" sidecar dance.

The overlay's container-level patches (e.g. paper-sidecar's `containers/- name: paper-sidecar, image: ghcr.io/...`) stay unchanged; kustomize already substitutes from the `images:` block.

### What this collapses from `create-service.md`

| Today's shape               | After v2                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Shape 1 — Standalone k8s    | "Add a catalog file with `images: [{role: app, ...}]`."                                                     |
| Shape 2 — Sibling container | "Add an `images: [{role: sidecar, ...}]` entry to the host node's catalog file."                            |
| Shape 3 — MCP               | Subcase of 1 (HTTP MCP = `app`) or 2 (stdio MCP = `sidecar`).                                               |
| Shape 4 — Compose (legacy)  | Unchanged — still a separate, sign-off-gated path for upstream third-party.                                 |
| Shape 5 — Cron / one-shot   | Unchanged — initContainer for one-shot, Shape 1 worker for periodic. Gap (true CronJob) tracked separately. |

The guide collapses from 5 shapes to "catalog file or catalog entry, plus k8s manifests."

## Migration Plan

**Single PR with operator-approved multi-domain scope.** [SINGLE_DOMAIN_HARD_FAIL](./node-ci-cd-contract.md) would normally force sequencing because the refactor crosses operator (catalog, scripts, workflows) and poly (sidecar file relocation under `nodes/poly/sidecars/`). The operator has waived the gate for this refactor — splitting buys no safety since the rename and the schema bump are semantically coupled (catalog references the new path; helpers iterate the new shape; first-green-flight proves both together).

### Cogni-poly PR — single landing

Files touched, all in one PR:

- `infra/catalog/_schema.json` — bump to v2 (`schema_version: 2` required, new `deploy` + `images` blocks).
- `infra/catalog/poly.yaml` + `infra/catalog/scheduler-worker.yaml` — rewrite in v2 shape. `poly.yaml`'s `images:` array includes `poly-paper-sidecar` pointing at the new `nodes/poly/sidecars/paper-trader/Dockerfile`.
- `scripts/ci/lib/image-tags.sh` — new helpers; old ones removed.
- `scripts/ci/{detect-affected,promote-build-payload,resolve-pr-build-images}.sh` — migrated to new helpers.
- `git mv infra/images/poly-paper-sidecar/* nodes/poly/sidecars/paper-trader/` — Dockerfile, `server.py`, `AGENTS.md`, `tests/`.
- Delete `.github/workflows/build-poly-paper-sidecar.yml` — `pr-build` matrix takes over.
- `pnpm check:catalog` wired into `static` CI job + `pnpm check`.
- `tests/ci-invariants/` — new invariants (unique names, exactly one `role: app` per deploy unit, dockerfile resolves).
- `docs/guides/create-service.md` — rewrite from 5 shapes to 2.
- `.claude/skills/node-setup/SKILL.md` Phase 6b — updated to reference `images:[]` shape.
- Overlay kustomization comments — drop the first-`newTag:`-wins gotcha references (no longer applicable once promote-build-payload writes sidecar digests).

PR body must include explicit "single-node-scope: APPROVED cross-domain by operator for catalog v2 substrate" so the gate skip is auditable.

### Upstream sync — `Cogni-DAO/cogni`

Symmetric, single PR. operator.yaml + resy.yaml + scheduler-worker.yaml each get v2-shape; same script + schema + gate changes; same test invariants. No sidecar file move there (cogni-monorepo doesn't have one today). Single operator-domain PR.

### Sequence — upstream `Cogni-DAO/cogni`

Symmetric. Operator + resy each get the same v2 shape. No sidecar file moves needed there (cogni-monorepo doesn't have one). Single operator-domain PR.

### Rollback

PR-2 is the only PR with semantic risk. Rollback = `git revert`. Catalog v1 entries are unrecoverable from the git history alone (different field layout), so the revert restores v1 entries verbatim. CI scripts and helpers also revert. No deploy-branch state changes — production / preview / candidate-a deploy state is unchanged by the catalog-shape PR.

## Alignment with `node-ci-cd-contract.md`

| Contract invariant          | v2 behavior                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `FORK_FREEDOM`              | No new secrets. Catalog schema validation runs without secrets. ✅                                                 |
| `POLICY_STAYS_LOCAL`        | Catalog is per-repo. v2 strengthens, doesn't centralize. ✅                                                        |
| `LOCAL_GATE_PARITY`         | `pnpm check:catalog` runs locally and in CI. ✅                                                                    |
| `NO_RUNTIME_FETCHES`        | Catalog files are checked in; helpers read from `infra/catalog/`. ✅                                               |
| `SCRIPTS_ARE_THE_API`       | Workflows iterate from script-emitted JSON. v2 makes more script behavior catalog-driven, not workflow-inlined. ✅ |
| `BUILD_ONCE_PROMOTE_DIGEST` | Unchanged. Reinforced by removing per-sidecar build workflows. ✅                                                  |
| `SINGLE_RESPONSIBILITY`     | Workflow shapes unchanged. ✅                                                                                      |
| `SINGLE_DOMAIN_HARD_FAIL`   | Migration sequenced into per-domain PRs. See § Migration Plan. ✅                                                  |

## Acceptance Checks

**Automated** (gates PR-2):

- `pnpm check:catalog` passes locally and in CI.
- `pnpm test` includes invariants: unique `image.name` and `image_tag_suffix`, exactly one `role: app` per deploy unit, every `dockerfile` resolves.
- `detect-affected.sh` with a fixture changeset of `nodes/poly/sidecars/paper-trader/server.py` returns only `poly-paper-sidecar` as affected.
- `promote-build-payload.sh` with a payload containing all three poly images writes correct overlay entries (mocked promote-k8s-image).
- pr-build matrix on the PR builds poly, poly-migrator, AND poly-paper-sidecar without any standalone workflow.

**Manual** (one-shot after PR-2 merges):

1. Dispatch `candidate-flight.yml` for any open poly PR. Verify all three poly images promote into `deploy/candidate-a-poly`'s overlay.
2. Dispatch `promote-and-deploy.yml` to preview. Verify `verify-deploy(poly)` and `verify(smoke)` both pass externally.
3. Dispatch `promote-and-deploy.yml` to production. Verify same.
4. Add a throwaway sidecar entry to `poly.yaml` (e.g. `name: poly-test-sidecar, role: sidecar, dockerfile: nodes/poly/sidecars/test/Dockerfile`), commit, push. Verify pr-build's matrix grows by one leg and that leg succeeds. Then revert.

## Related

- [`docs/spec/node-ci-cd-contract.md`](./node-ci-cd-contract.md) — CI invariants, merge gate, single-domain scope.
- [`docs/spec/ci-cd.md`](./ci-cd.md) — pipeline chain + CATALOG_IS_SSOT axiom.
- [`docs/guides/create-service.md`](../guides/create-service.md) — current 5-shape guide; rewritten to 2 shapes in PR-2.
- [`.claude/skills/node-setup/SKILL.md`](../../.claude/skills/node-setup/SKILL.md) — Phase 6b catalog declaration requirement (bug.5002).
- bug.5002 (closed) — first half of catalog-driven CI: per-env public URLs.
- bug.5004 (open) — `promote-build-payload.sh` hardcoded list; closed by construction by this spec.
- bug.5005 (open) — AppSet generator catalog-glob; orthogonal but unblocked by this spec.
- Upstream sync — symmetric PRs against `Cogni-DAO/cogni` for operator + resy catalog files.
