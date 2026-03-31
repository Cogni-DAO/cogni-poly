---
name: deploy-config
description: "Deploy readiness audit for a feature branch. Analyzes whether the current change will deploy and work in preview/production by checking env vars, Docker services, CI pipeline wiring, secrets, and compose profiles. Use this skill when a feature introduces new infrastructure dependencies (env vars, Docker services, API keys, database changes) and you need to verify the deploy pipeline will handle them. Trigger on: 'will this deploy?', 'deploy readiness', 'what do I need for production?', 'check deploy config', 'env gap analysis', or after implementing a feature that adds new env vars, Docker services, or external dependencies."
---

# Deploy Config — Readiness Audit

You are a deploy readiness auditor. Your job is to analyze the current feature branch and produce a gap analysis: what new infrastructure does this feature require, and is the CI/CD pipeline wired to deliver it? You do NOT deploy anything. You identify what's missing so the developer can fix it before merge.

## Why This Matters

A feature that passes `pnpm check` locally can still fail in production if:

- A new env var exists in code but not in the deploy workflow's secret list
- A new Docker service is defined in compose but the deploy script doesn't start it
- A database migration exists but the migration runner doesn't pick it up
- A new package has native deps that aren't in the Dockerfile

The gap between "works locally" and "works in production" is where features die. This audit closes that gap.

## Audit Process

### 1. Identify what the feature introduces

Read the diff to catalog every new infrastructure dependency:

```bash
git diff origin/staging...HEAD --name-only
```

Check each category:

**New env vars** — grep for additions to server-env.ts:

```bash
git diff origin/staging...HEAD -- apps/web/src/shared/env/server-env.ts
```

**New Docker services** — check compose changes:

```bash
git diff origin/staging...HEAD -- infra/compose/runtime/docker-compose.dev.yml
```

**New database migrations** — check for new SQL files:

```bash
git diff origin/staging...HEAD --name-only -- '*.sql' '*_journal.json'
```

**New packages with native deps** — check for new workspace packages or binary dependencies:

```bash
git diff origin/staging...HEAD -- pnpm-lock.yaml | grep 'added' | head -20
```

**New external API dependencies** — look for new fetch/HTTP calls to services not previously used.

### 2. Trace each dependency through the deploy pipeline

For each new dependency found in step 1, verify it's wired end-to-end:

#### Env Var Checklist

For each new env var (e.g., `STEEL_API_URL`):

| Check                         | How                                                                  | Status |
| ----------------------------- | -------------------------------------------------------------------- | ------ |
| Defined in server-env.ts      | `grep VAR_NAME apps/web/src/shared/env/server-env.ts`                |        |
| In .env.local.example         | `grep VAR_NAME .env.local.example`                                   |        |
| In .env.test.example          | `grep VAR_NAME .env.test.example`                                    |        |
| In CI workflow env block      | `grep VAR_NAME .github/workflows/staging-preview.yml`                |        |
| In deploy.sh env passthrough  | `grep VAR_NAME scripts/ci/deploy.sh`                                 |        |
| In GitHub environment secrets | `gh secret list --env preview \| grep VAR_NAME` (if you have access) |        |
| Optional vs required          | Is the code safe when this var is undefined?                         |        |

**Critical rule**: If the var is **optional** and the code gracefully handles `undefined`, missing pipeline wiring is acceptable (feature is just disabled in that env). If the var is **required**, every cell in the table must be filled or the deploy will break.

#### Docker Service Checklist

For each new service (e.g., `steel-browser`):

| Check                           | How                                                              | Status |
| ------------------------------- | ---------------------------------------------------------------- | ------ |
| Defined in compose              | `grep SERVICE_NAME infra/compose/runtime/docker-compose.dev.yml` |        |
| Has healthcheck                 | Check the compose definition                                     |        |
| Profile or always-on?           | Is it gated by `profiles: [name]`?                               |        |
| Deploy script activates profile | `grep PROFILE_NAME scripts/ci/deploy.sh`                         |        |
| Image is public/pullable        | Can the VM pull it without extra auth?                           |        |
| Volumes persist across deploys  | Named volume (not bind mount)?                                   |        |
| Network matches app             | On `cogni-edge` or `internal`?                                   |        |
| Port conflicts                  | Does it clash with existing services?                            |        |

**Critical rule**: If the service uses a compose `profile`, the deploy script must pass `--profile NAME` or the service won't start in production. If the service should always run for this node, remove the profile.

#### Migration Checklist

For each new migration:

| Check                        | How                                                                  | Status |
| ---------------------------- | -------------------------------------------------------------------- | ------ |
| SQL file in migrations/      | `ls apps/web/src/adapters/server/db/migrations/NNNN_*.sql`           |        |
| Journal updated              | New entry in `meta/_journal.json` with correct idx                   |        |
| Drizzle schema matches       | Column in `packages/db-schema/src/*.ts` matches migration            |        |
| Migration is additive        | ALTER ADD COLUMN / CREATE TABLE (not destructive)                    |        |
| db-migrate container runs it | Bootstrap profile runs `db-migrate` which applies pending migrations |        |

#### Package / Dockerfile Checklist

For each new package:

| Check                     | How                                          | Status |
| ------------------------- | -------------------------------------------- | ------ |
| In pnpm-workspace.yaml    | Already covered by `packages/*` glob?        |        |
| Built by packages:build   | `pnpm packages:build` succeeds               |        |
| No native binaries needed | Check for `.node` files, postinstall scripts |        |
| Dockerfile copies it      | Multi-stage build includes the package?      |        |

### 3. Produce the Gap Report

Output a structured report:

```markdown
## Deploy Readiness: [feature name]

### New Dependencies

- [list each new env var, service, migration, package]

### Pipeline Status

| Dependency     | Local                 | CI Build     | CI Deploy            | Preview Env   | Production Env | Gap?                                   |
| -------------- | --------------------- | ------------ | -------------------- | ------------- | -------------- | -------------------------------------- |
| STEEL_API_URL  | .env.local            | workflow env | deploy.sh            | gh secret     | gh secret      | YES: not in deploy.sh                  |
| steel-browser  | compose profile:steel | n/a          | not activated        | needs profile | needs profile  | YES: deploy.sh missing --profile steel |
| migration 0029 | drizzle               | pnpm check   | db-migrate bootstrap | auto          | auto           | OK                                     |

### Blocking Gaps

[List anything that will cause deploy failure or silent feature breakage]

### Non-Blocking Gaps

[List anything where the feature gracefully degrades — works but feature is disabled]

### Recommended Actions

[Specific commands or file edits to close each gap, with file:line references]
```

### 4. Create or update a tracking task

If blocking gaps exist, check if there's already a work item tracking them. If not, recommend creating one (e.g., task.0228 tracks Steel deploy wiring). Don't create the task yourself — suggest it to the developer.

## Deploy Pipeline Reference

These are the key files that form the deploy pipeline. Read them to understand how dependencies flow:

| File                                           | Role                                  | What to check                           |
| ---------------------------------------------- | ------------------------------------- | --------------------------------------- |
| `apps/web/src/shared/env/server-env.ts`        | Env var definitions + validation      | New vars added here                     |
| `.env.local.example` / `.env.test.example`     | Dev/test env templates                | New vars documented                     |
| `.github/workflows/staging-preview.yml`        | CI: build → deploy → e2e → promote    | Env vars passed to deploy job           |
| `.github/workflows/deploy-production.yml`      | Prod deploy (triggered by main merge) | Same env vars as preview                |
| `scripts/ci/deploy.sh`                         | Remote deploy script (SSH to VM)      | Env written to .env, profiles activated |
| `scripts/ci/build.sh`                          | Docker image build                    | New deps included in image              |
| `infra/compose/runtime/docker-compose.dev.yml` | Service definitions                   | New services, profiles, volumes         |
| `apps/web/Dockerfile`                          | App container build                   | New packages copied                     |

## Compose Profiles Currently Active in Deploy

The deploy script (`scripts/ci/deploy.sh`) currently activates these profiles:

- `bootstrap` — one-time init: db-provision, db-migrate, git-sync, repo-init
- `sandbox-openclaw` — OpenClaw gateway + LLM proxy

**NOT activated** (opt-in, manual):

- `steel` — Steel browser sessions
- `tigerbeetle` — Financial ledger

If your feature depends on a service behind an inactive profile, that's a blocking gap.
