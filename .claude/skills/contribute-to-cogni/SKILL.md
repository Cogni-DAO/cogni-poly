---
name: contribute-to-cogni
description: E2E contributor contract for external agents submitting code to Cogni. Load this first. Covers the full lifecycle from worktree setup through candidate-a validation and PR acceptance. Use whenever an agent is contributing code to this repo.
---

# Cogni Contributor Contract

You are an external agent contributing code. Work is only accepted after **all 4 phases** complete.

This skill is the executable wrapper around the root [`AGENTS.md`](../../../AGENTS.md) Required Agent Loop and [`docs/spec/development-lifecycle.md`](../../../docs/spec/development-lifecycle.md). Use those for architecture/background. Use this file for the shortest path through the contribution gate.

At each phase: search the resource roots below for the relevant guides, specs, and skills — they exist. Follow them. Return to this loop. Do not invent a parallel lifecycle.

## Resource Roots

- `.claude/skills/` — executable skills
- `.claude/commands/` — slash commands
- `work/charters/` — project charters and scope
- Active work items live at `https://poly.cognidao.org/api/v1/work/items` (CRUD via Bearer auth)
- `docs/guides/` — how-to guides
- `docs/spec/` — architecture and design specs
- `docs/runbooks/` — operational procedures

---

## Phase 1 — Implement

1. Worktree off `main`. Read the root `AGENTS.md` and the `AGENTS.md` files for every dir you'll touch.
2. Bearer token: use `$COGNI_API_KEY_PROD` from `.env.cogni` (poly-scoped). If missing, register against the poly node and save the result:
   ```bash
   BASE=https://poly.cognidao.org
   curl -sS -X POST $BASE/api/v1/agent/register \
     -H "Content-Type: application/json" \
     -d '{"name": "<agent-name>"}'
   # → save apiKey as COGNI_API_KEY_PROD, userId as COGNI_USER_ID_PROD,
   #   billingAccountId as COGNI_BILLING_ACCOUNT_PROD in .env.cogni
   ```
3. **Tie your work to exactly one work item. 1 work item ≈ 1 PR.** Prefer adopting an existing item over creating a new one (anti-sprawl).
   - Already assigned? Use it.
   - Looking for work? Query `GET $BASE/api/v1/work/items?statuses=needs_implement,needs_design` first.
   - New request that fits nothing existing? Create it:
     ```bash
     curl -X POST $BASE/api/v1/work/items \
       -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
       -d '{"type":"task","title":"<short>","node":"<node>","summary":"<why>"}'
     # → { "id": "task.NNNN" }   (server-allocated)
     ```
     Keep the item lean: a one-line `outcome` describing successful E2E validation (a user-facing capability, or a specific response after repro condition X). Decompose only via `/design` if the task can't ship as one PR — don't fan out child tasks.
4. Find and follow the relevant lifecycle skills: `/triage → /design → /implement → /closeout`. PATCH the work item with `branch` + `pr` + `status` as you progress (`{"set":{...}}` body shape) so `dolt_log` reflects state. Coordination sub-routes (claims/heartbeat/pr/coordination) are not yet wired in cogni-poly — track session state via PR description + work item PATCHes.
5. Run the smallest checks that cover your edited surface; normally `pnpm check:fast` must pass unless a human explicitly narrows verification. Push branch. `gh pr create` with a conventional commit title.

## Phase 2 — Flight Request

6. Wait until all required CI checks are green on your PR head SHA.
7. Dispatch the candidate-flight workflow: `gh workflow run candidate-flight.yml -R Cogni-DAO/cogni-poly --ref <branch> -f pr_number=<N>`.

## Phase 3 — Self-Validate

8. Wait for the `candidate-flight` check to appear on your PR head and confirm `https://poly-test.cognidao.org/version` serves that SHA.
9. Run [`/validate-candidate`](../validate-candidate/SKILL.md) for the PR. Do **not** hand-roll this step. It owns the required matrix, feature-specific exercise, Loki query, and PR scorecard format.
10. If validation fails: fix, push, repeat from Phase 1. Stale PRs with failed validation are closed.

## Phase 4 — Merge + Close

11. Mark PR "ready for review" only after the validation comment is posted and green.
12. Reviewer merges.
13. **Only after merge to `main`:** PATCH `status: done` on the work item. Pre-merge → status stays `needs_merge`. Review-rejected → status flips back to `needs_implement` (address feedback, push, re-validate). _vNext: close gate moves to "promoted to production" once that lane is wired._

---

**PRs are never "ready for review" before Phase 3 is complete.**
