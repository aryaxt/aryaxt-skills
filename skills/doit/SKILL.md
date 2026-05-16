---
name: doit
description: Use when the user says "doit" or asks to ship the current work — reviews local/committed changes, splits into focused PRs if needed, runs multi-dimensional parallel review, resolves all feedback, and merges.
---

# Do It — Full PR Shipping Workflow

Orchestrates the complete path from local changes to merged PR(s): scope analysis → split decision → branch + PR creation → parallel multi-agent review → feedback resolution → merge.

## Step 1 — Understand what's changed

```bash
# Staged + unstaged changes not yet committed
git diff HEAD

# Commits on this branch not yet on main
git log origin/main..HEAD --oneline

# Files touched
git diff origin/main --name-only
```

Read every changed file. Build a mental map: **what problem does each change solve?**

## Step 2 — Decide: one PR or many?

Split into multiple PRs **only** when changes clearly serve independent purposes — different features, unrelated bug fixes, or a refactor mixed with new behaviour. Use this rubric:

| Signal | Split? |
|--------|--------|
| Files touch completely unrelated domains | Yes |
| One set of changes could ship without the other | Yes |
| Changes are all part of a single cohesive feature/fix | No |
| Only one or two files changed | No |
| Changes are tightly coupled (one breaks without the other) | No |

When in doubt, **keep it one PR**. Unnecessary splitting adds overhead without benefit.

## Step 3 — Create branch(es) and PR(s)

For each logical unit of work:

```bash
git checkout -b <descriptive-branch-name>
# cherry-pick or stage only the relevant commits/files
git push -u origin <descriptive-branch-name>
```

Write the PR body using this template — pull details from the **current conversation context** (what the user said, what was being built, why):

```
## Summary
<2-4 bullets: what changed and why — use conversation context for the "why">

## Changes
<file-by-file bullet list of what was modified and what it does>

## Testing
<what was tested, how, and what edge cases were covered>

## Notes
<breaking changes, migrations needed, things reviewers should pay attention to>
```

Good PR descriptions answer: *what*, *why*, *how tested*, and *what to watch out for*. Sparse descriptions are not acceptable.

## Step 3.6 — Admin surface check (before review)

Approaching production: avoid creating data or operational state that nobody can inspect.

Ask one question of the diff:

> **"Does this introduce new persisted state, configuration, or operational levers that someone (you, support, future-you) will need to inspect or change outside the user-facing app?"**

| Answer | Action |
|---|---|
| **No** — pure UI tweak, refactor, bug fix, or self-managing data | Skip. Don't add admin-for-the-sake-of-admin. |
| **Yes, and an admin page already covers it** | Confirm the new field/state shows up there. If not, expand the existing page — don't add a new one. |
| **Yes, and no admin page exists** | Propose a minimal one: read-only inspection first; mutation only if you can name a specific operational scenario that needs it (e.g. refund support, force-end a stuck job). |

**Don't overbuild.** A read-only Firestore viewer is often enough. Skip CRUD UIs for data the app already manages correctly. If you're unsure whether it's needed, ask the user — don't guess.

## Step 3.7 — Cross-platform parity check (before review)

Per AGENTS.md "Cross-Platform Parity" and the project's mobile-first convention: user-facing features must reach every platform they belong on, with the same naming, same content, same server contract. Drift starts when a feature ships on iOS and "we'll do web later" silently rots.

Classify the change:

| Type | Action |
|---|---|
| Bug fix or refactor scoped to one platform | Fine — single-platform is correct. |
| New user-facing feature on iOS only (project is mobile-first) | iOS-first is correct. **But before merge**, file a follow-up GitHub issue tracking the web counterpart, with the iOS PR linked. Include slot IDs, scene IDs, copy strings, and the server contract so web doesn't drift. |
| New user-facing feature on web only | Justify — usually this is wrong direction per mobile-first. Ask the user before merging unless the feature is web-native (admin, marketing, onboarding email landing, etc.). |
| Server change (new field, new endpoint, new behavior) without matching client changes | Confirm both clients can consume the new contract — or that the change is purely additive and backwards-compatible. |
| Hardcoded catalogue (slots, scenes, copy) duplicated across platforms | Verify the `KEEP IN SYNC WITH <other-platform-path>` comment exists per AGENTS.md. Long-term these should move server-side. |

**Don't silently diverge.** If the change is intentionally not shipping cross-platform, say so in the PR description so a future reviewer doesn't try to "fix" the missing platform.

## Step 3.8 — API caching strategy check (before review)

Whenever the diff adds or modifies a route under `src/app/api/**/route.ts`, caching is a deliberate decision — not a default. Skipping it on a high-traffic GET is a real, measurable cost (bandwidth, iOS decode time, server load on launch storms); applying it carelessly to a user-scoped or write-heavy endpoint is a correctness bug (cross-user cache poisoning, stale writes).

```bash
DIFF_FILES=$(git diff origin/main..HEAD --name-only)
ROUTE_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^src/app/api/.*route\.ts$' || true)
```

If `ROUTE_DIFF` is empty, skip this step. Otherwise, for each route, classify it and confirm the caching choice fits.

| Route shape | Caching strategy |
|---|---|
| **GET, global content** (catalogs, config, version-locked data — same payload for every caller, admin-edited rarely) | **MUST** use `withEtag(...)` from `src/lib/http/etag.ts`. `public, max-age=N` if unauthenticated; `private, max-age=N` if auth-gated. Pick `N` from the data's actual change cadence — money/credit-grant data short (≤ 2 min), catalog data medium (5–60 min), version-locked data long (1 day+). |
| **GET, user-scoped content** (gallery, profile, per-user state — payload differs per caller) | **Do NOT use `withEtag` without `Vary: Authorization`.** The default URLCache will cache across users on the same device after sign-out/sign-in → cross-user data leak. Usually the right answer is no HTTP cache; the iOS client should use a Firestore listener or in-memory cache instead. |
| **GET, real-time / volatile** (job status, polling endpoints, anything that changes within seconds) | No HTTP cache. Set `Cache-Control: no-store` if a proxy might cache. Use server-sent events or Firestore listeners for the live signal. |
| **POST / PUT / DELETE / PATCH** | Never cacheable. No action — but verify the response doesn't accidentally include `Cache-Control: public` from a copy-paste. |

**The thoughtful-decision rule:** every new or modified `/api/**/route.ts` in the diff must be classifiable into exactly one row above. If the PR description doesn't mention the caching choice (or absence of one) for a new GET route, that's a gap — either add it to the description or flag it as **Important** before review.

**Red flags to surface as findings:**
- A new GET catalog/config route that doesn't use `withEtag` → flag as Important (asks the user: is this intentional?).
- `withEtag` used on a route whose payload could vary per user → flag as Critical (cache-poisoning risk).
- A route that already uses `withEtag` but the TTL was bumped/dropped without rationale in the commit message → flag as Important.
- New `Cache-Control: public` on an auth-gated route → flag as Critical.

When in doubt: the iOS app's perspective is "how often will the client call this, and how stale can it be?" — that's the question the route's author needs to have answered. If they can't, the route is under-designed, not just under-cached.

## Step 3.9 — Documentation check (before review)

A code change can silently invalidate the docs the next engineer (or Claude session) will trust. Before review, decide whether this diff needs a docs update — and where. Three questions, in order:

**1. Did this change make an existing doc stale?**
Scan `docs/` — especially `docs/features/*.md` — for any file describing a system this diff touched (file inventory, data flow, secrets, runbook, kill switch, schema). If the diff changes behavior a doc describes, update the doc in the same PR. A feature doc that lies is worse than no doc.

**2. Does this change warrant a NEW doc?**
Per CLAUDE.md, add `docs/features/<feature>.md` when you ship something "complex enough that re-deriving how it works from code would be slow" — multi-file features, operational levers (kill switches, queues, cron jobs), anything with a runbook, secrets, or a non-obvious data flow. A pure UI tweak / bug fix / refactor does NOT need one. When in doubt, ask the user.
- If the feature affects iOS rendering that unit tests can't reach, also add a `## Visual smoke test` section (see CLAUDE.md "Visual smoke tests").

**3. Do CLAUDE.md / AGENTS.md need updating?**
These two files are **always loaded into context** — every token in them is paid on every session. Treat them as an *index*, not a manual.

| Situation | Action |
|---|---|
| New `docs/features/<feature>.md` created | Add ONE line to CLAUDE.md's "Currently documented features" list: a markdown link + a short "read this first if…" hook. **Do not** paste the doc's content into CLAUDE.md. |
| New durable convention/rule that applies to all future work (e.g. "always use X helper") | If it's genuinely short (1–3 lines), it can live directly in CLAUDE.md / AGENTS.md. If it needs more, put the detail in a `docs/` file and add a one-line pointer. |
| Normal feature/fix with no new cross-cutting rule | No CLAUDE.md / AGENTS.md change. Most PRs land here. |

**The pollution rule:** CLAUDE.md and AGENTS.md grow by *links*, not by *prose*. If you're about to add more than ~3 lines to either file, that content belongs in a `docs/` file with a one-line pointer from CLAUDE.md instead — so it loads into context only when actually needed.

If any doc work is needed, do it now (same PR) before dispatching review — the review agents should see the docs alongside the code.

## Step 4 — Parallel multi-agent review

Dispatch review agents **in a single parallel batch** (one Agent tool call per reviewer). Pre-launch, the cost of shipping a bug is much higher than the cost of running extra agents — bias toward running the full fleet.

### Step 4.0 — Decide: full fleet, intent-only, or skip

Three possible dispatches, in order of preference:

**Default: full fleet.** Run every applicable agent. This is what every non-trivial change gets.

**Intent-only dispatch:** Run only the **Intent & approach** agent. Use this when *all three* are true:
1. Diff is purely typo / comment / asset / copy / formatting — no behavior change.
2. No auto-escalator fires (see below).
3. Less than 20 lines changed across no more than 3 files.

**Skip entirely:** Never. Even a comment-only change can be wrong (wrong file, wrong function being documented, misleading wording about a security-sensitive piece). Intent & approach is cheap — always run it.

### Auto-escalators — ANY of these fires → **full fleet, no exceptions**

These override the main agent's judgment. Run the bash blocks below first; if any returns non-empty output, dispatch every applicable agent.

```bash
DIFF_FILES=$(git diff origin/main..HEAD --name-only)

# Money/credits — credit service, IAP, webhooks, refunds, App Store notifications
MONEY_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E 'credit-service|video-credit-service|iap-|apple-notifications|webhook|refund' || true)

# Auth — anything that decides who can do what
AUTH_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E 'auth-helpers|isAdmin|verifyAuthHeader|account-deletion-service' || true)

# Production secrets / infra
INFRA_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^(apphosting\.yaml|firebase\.json|firestore\.indexes\.json|\.env|next\.config)' || true)

# Removed/deleted files — removal is higher risk than addition
REMOVED_FILES=$(git diff origin/main..HEAD --diff-filter=D --name-only || true)

# Rendering hot paths — gallery, editor, app launch, the image-load layer.
# A change here must never be downgraded to intent-only review: PR #402
# shipped a correct, secure, well-tested signed-URL design that forced a
# blocking /api/media/sign round-trip per gallery cell and regressed load.
HOT_PATH_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^src/app/\(main\)/dashboard/|^src/components/(gallery|editor)/|^ios/[^/]+/Views/Dashboard/|^ios/[^/]+/Views/Shared/CachedAsyncImage\.swift|^ios/[^/]+/Services/ImageCache\.swift|^src/app/layout\.tsx$' || true)
```

Plus the existing pre-flights below — `SCHEMA_DIFF`, `RULES_DIFF`, `ADMIN_ROUTE_DIFF`, `NEW_ROUTES` — any non-empty result forces the full fleet.

| Auto-escalator | Why it overrides "this looks small" |
|---|---|
| `MONEY_DIFF` non-empty | Touches revenue. 1-line bug = money leak. |
| `AUTH_DIFF` non-empty | 1-line bug = access-control vulnerability. |
| `SCHEMA_DIFF` / `RULES_DIFF` non-empty | Data corruption or rules bypass. |
| `ADMIN_ROUTE_DIFF` or admin-flavored `NEW_ROUTES` | Privilege escalation surface. |
| `INFRA_DIFF` non-empty | Broken builds, leaked secrets, wrong indexes in production. |
| `REMOVED_FILES` non-empty and not pure cleanup | Removal regressions are silent — no test exercises the gone code. |
| `HOT_PATH_DIFF` non-empty | Touches a rendering hot path (gallery, editor, launch, image-load layer). A latency / degradation regression here is the PR #402 class — it must get the full fleet, never intent-only. |

### Anti-rationalization checklist (before going intent-only)

Before dispatching intent-only, confirm — out loud in the merge comment — that all three are false:

- [ ] Could this change affect what a user sees, pays, or can access?
- [ ] Could this change cause data or money to move differently?
- [ ] Is this a "small fix" I haven't fully understood yet?

Any yes → full fleet.

### Pre-flight: detect data-layer changes

Before dispatching, classify whether the diff touches Firestore/Storage schema, rules, or persistence code — this decides whether the Data design agent runs.

```bash
DIFF_FILES=$(git diff origin/main..HEAD --name-only)

# Rules files changed
RULES_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^(firestore|storage)\.rules$' || true)

# Rules tests changed
RULES_TESTS_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^src/__tests__/rules/' || true)

# New/changed Firestore writes (server or client). Catches addDoc/setDoc/updateDoc/collection()/doc()
# in TS, and Firestore writes in Swift (db.collection / Firestore.firestore).
SCHEMA_DIFF=$(git diff origin/main..HEAD -G "addDoc|setDoc|updateDoc|collection\(|doc\(|Firestore\.firestore|db\.collection" --name-only || true)
```

`SCHEMA_DIFF` non-empty → run **Data design** agent. `SCHEMA_DIFF` non-empty AND `RULES_DIFF`/`RULES_TESTS_DIFF` empty → flag as a likely **Critical** gap before review even starts (CLAUDE.md requires both for any schema change).

### Pre-flight: detect admin-route changes

```bash
# New or modified routes under /api/admin/*
ADMIN_ROUTE_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^src/app/api/admin/.*route\.ts$' || true)

# New routes ANYWHERE — these are the high-risk class to scan, because a sensitive
# action could be wired up under /api/foo/* and skip the manifest entirely.
# Filter to *added* files (status 'A') so we surface brand-new routes specifically.
NEW_ROUTES=$(git diff origin/main..HEAD --diff-filter=A --name-only -- 'src/app/api/**/route.ts' || true)

# Manifest changes
MANIFEST_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^src/__tests__/security/admin-routes-manifest\.ts$' || true)
```

For each route in `ADMIN_ROUTE_DIFF`: verify it imports `isAdmin` from `@/lib/firebase/auth-helpers` AND that it's listed in the manifest. If touched but manifest unchanged, surface as **Critical** before review.

For each route in `NEW_ROUTES` that's *not* under `/api/admin/*`: open the file and ask "does this perform an admin-only action?" (mutates config, force-ends a job, views another user's data, refunds/adjusts credits, deletes data on behalf of another user). If yes → it must use `isAdmin` AND register in the manifest, even though its URL isn't `/api/admin/*`. Flag as **Critical** if either is missing.

### Agents

Spawn these agents simultaneously:

| Agent | Focus |
|-------|-------|
| **Intent & approach** | Does this change do the *right thing*? Step back from line-level review and ask: (1) What problem is this solving — articulate it back in one sentence from reading the diff + PR description + (if provided) the original user request. (2) Does the implementation actually solve that problem, or does it solve a near-but-different problem? (3) Is there a simpler / more obvious approach the codebase already has? (look for existing utilities/services/patterns the change should have used instead of inventing new ones). (4) Did the change creep beyond what was asked? (5) Does the architectural choice fit existing patterns in this repo, or does it introduce a parallel way of doing something already done elsewhere? This is the *only* agent that reads the user's original intent — every other agent assumes the change is conceptually correct. Findings here override everything else: a perfectly-coded change that solves the wrong problem is still wrong. |
| **Code quality** | Naming, readability, DRY, YAGNI, unnecessary complexity |
| **Security** | Injection, auth bypasses, secrets exposure, input validation gaps. **Admin-route auth specifically:** any new or modified route under `src/app/api/admin/**`, or any route outside `/api/admin/*` that performs an admin-only action (force-end a job, mutate config, view another user's data, refund/adjust credits), must (1) call `verifyAuthHeader` + `isAdmin` from `src/lib/firebase/auth-helpers.ts` and return 401/403 on failure, AND (2) be listed in `src/__tests__/security/admin-routes-manifest.ts` so the behavioral test exercises it. Missing either is **Critical** — the manifest gap lets the architectural invariant test pass vacuously. |
| **Separation of concerns** | Business logic leaking into UI/routes, God objects, mixed responsibilities, code structured in a way that makes it untestable (hidden dependencies, untyped boundaries, side effects in constructors) |
| **Simplicity** | Over-engineering, premature abstraction, code that could be half the size |
| **Tests** | Missing tests entirely for new logic (not just coverage gaps); branches/edge cases not exercised; tests that pass even if the logic breaks; rules tests missing when `firestore.rules` / `storage.rules` changed |
| **Root cause** | Hacks vs. real fixes — band-aids that mask the underlying bug, `try/catch` that swallows errors silently, special-cases for one weird input instead of fixing the type/contract, commented-out code left behind, `// HACK` / `// FIXME` comments, magic constants that should be config, "works for now" shims. Each finding must name the symptom AND the root cause that's being papered over. |
| **Bug hunter** | Concrete logic bugs that would fire at runtime: off-by-one, wrong variable used, null/undefined/optional access without check, async/await mistakes (missing `await`, fire-and-forget promises), wrong comparison operator, conditions that can't both be true, race conditions on shared state, type coercion gotchas. Distinct from "code quality" — this is "does it work?", not "is it pretty?" |
| **Hot-path performance & degradation** | Does this regress *user-perceived* performance on a rendering hot path — the gallery, the editor, app launch, any high-frequency list/grid? (1) Does it add a network round-trip, an N+1 pattern, or blocking work **before first paint** on a screen the user hits constantly? (2) Does a new dependency (an API call, a signed-URL resolution, a Firestore read) now sit on the critical render path where the old code rendered synchronously? (3) **Graceful degradation** — when that dependency is slow, times out, or fails, what does the user see: a spinner that resolves, or a permanently-blank cell? (4) Is there a before/after first-paint cost, and is it stated in the PR description? Every other agent assumes the change is conceptually sound and reviews within that frame — this agent is the one that asks *what it costs the user*. A clean, secure, well-tested implementation of a hot-path-hostile design is still a regression (this agent exists because PR #402 — signed-URL media — passed every other gate and still serialized gallery load behind a per-cell round-trip). |
| **Data design** *(only if `SCHEMA_DIFF` non-empty)* | (1) Firestore conventions: collection names plural+camelCase, fields camelCase, no nested-map abuse where a subcollection fits, timestamps as `Timestamp` not strings, IDs as strings not numbers, no boolean flags that should be enums. (2) Read/write patterns scale: no unbounded subcollections under hot docs, no queries that would force a fanout index, batches/transactions used where consistency matters. (3) **Rules + rules tests** added per CLAUDE.md (field-level whitelists for client-writable docs, server-only collections set `allow read, write: if false`). (4) **Migration/cleanup**: if fields were renamed or removed, is there a backfill or cleanup script? Are old docs left as garbage? (5) Indexes declared in `firestore.indexes.json` for new composite queries. |
| **Analytics / tracking** | New user-facing action shipped without an analytics event (web: `Analytics.*` from `src/lib/firebase/analytics.ts`; iOS: `Analytics.logEvent` via `ios/.../Services/AnalyticsService.swift`). Existing event names/params changed in a way that breaks dashboards/funnels. PII (email, prompts, user IDs beyond what we already log) accidentally being sent as event params. Same event firing twice on the same action (silent metric inflation). Event names inconsistent with existing convention (snake_case in iOS calls, see `photo_generated` / `edit_applied` / `model_training_started`). |
| **Credits / billing** | Any new code path that calls AI generation, video generation, model training, or any other paid action — does it go through `useCredit` / `hasCredits` from `src/lib/services/credit-service.ts` (or `getVideoCreditCost` for video)? Server route handlers must check credits *before* the paid call; refund (`addCredits`) on failure to avoid silent revenue leak. Conversely: code that grants credits (`addCredits`, `addCreditsInTransaction`) outside of the IAP/webhook/admin flows is a giveaway bug. Changes to the IAP receipt / webhook handlers, App Store Connect notifications, or refund paths warrant **Critical** scrutiny — these touch money directly. If the diff *should not* affect credits (e.g. a pure UI refactor) and yet touches any credit-service call site, flag it. |

Each agent receives:
- The full git diff for the PR
- The PR description
- Its specific review dimension
- Instruction to return findings as: **Critical** / **Important** / **Minor** / **Looks good**

The **Intent & approach** agent additionally receives the **original user request from this conversation** (verbatim, or a faithful paraphrase if the conversation is long). Without that, it can't evaluate whether the change is the *right* change — only whether the code is internally consistent.

Example dispatch prompt per agent:
```
Review the following diff from the perspective of [DIMENSION].
Diff: <paste diff>
PR description: <paste description>
Return findings as Critical / Important / Minor / Looks good.
Do not comment on dimensions outside your focus.
```

Example dispatch prompt for the **Intent & approach** agent:
```
Review the following diff from the perspective of intent and approach.

Original user request (from the conversation that produced this change):
<paste verbatim or faithful paraphrase>

Diff: <paste diff>
PR description: <paste description>

Your job: (1) articulate back in one sentence what this change does, (2) articulate
in one sentence why it appears to be done, (3) evaluate whether the implementation
solves the stated problem (vs. a near-but-different one), (4) flag if a simpler or
more obvious approach existed in the codebase, (5) flag scope creep beyond what was
asked, (6) flag architectural drift from existing patterns.

Return findings as Critical / Important / Minor / Looks good.
Do not comment on naming, security, tests, etc. — other agents cover those.
```

**Severity calibration for the new agents:**
- *Intent & approach:* solves the wrong problem entirely = **Critical** — stop and renegotiate scope with the user, do not merge. Solves the right problem but obviously misses a much simpler approach the codebase already has = **Important**. Right problem, reasonable approach, minor architectural drift = **Minor**. If this agent says "Looks good" treat it as a strong signal — it's the only one that read the user's original intent.
- *Root cause:* a band-aid that hides a bug = **Critical**. A workaround clearly labeled with a `// TODO: real fix tracked in #N` and a credible reason = **Minor**.
- *Bug hunter:* anything that would crash/misbehave on a realistic input = **Critical**. Theoretical race that requires contrived timing = **Minor**.
- *Data design:* missing rules or rules tests on a new client-writable collection/field = **Critical** (CLAUDE.md says so). Missing migration for a removed field = **Critical** if old docs would silently break a query; **Important** otherwise. Naming/convention nits = **Minor**.
- *Analytics:* PII leaking into event params or a duplicate-firing event that inflates metrics = **Critical**. New user action with no event at all = **Important**. Event-name convention drift = **Minor**.
- *Credits:* paid-action path that bypasses `useCredit` / `hasCredits` = **Critical**. Missing refund on server-side failure = **Critical** (silent revenue leak). Granting credits outside IAP/webhook/admin = **Critical**. Anything ambiguous in IAP / refund / webhook code = **Important** at minimum — escalate to user before merge.
- *Hot-path performance & degradation:* a new blocking round-trip / N+1 / per-item network dependency **before first paint** on a hot path = **Critical** — do not merge; the *design* needs to change, not the code. A new render-path dependency with no graceful-degradation story (blank-forever on failure) = **Critical**. A bounded latency add on a non-hot path, or a hot-path add that is already async / cached / non-blocking with a real fallback = **Minor**. "Looks good" here means the change either doesn't touch a hot path or keeps the render path synchronous/cached.

## Step 4.5 — Surface the review report (REQUIRED before triage)

Before acting on findings, present the review outcome in a structured report the user can scan in one read. The agents have completed; the user needs to see WHO ran and WHAT they found before fixes start flowing.

Output exactly two tables, in this order, with the actual data from the dispatched run.

### Reviewers run

| Agent | Dimension | Top verdict |
|---|---|---|
| code-quality | naming / DRY / readability | <Critical / Important / Minor / Looks good> |
| security | injection / auth / secrets / IDOR | <verdict> |
| separation-of-concerns | layer leakage / mixed responsibilities | <verdict> |
| simplicity | over-engineering / premature abstraction | <verdict> |
| tests | coverage / mock quality / missing branches | <verdict> |
| (any additional fleet agents — see Step 4.0) | <their dimension> | <verdict> |

### Findings

| # | Severity | Source agent(s) | File:line | Summary | Disposition |
|---|---|---|---|---|---|
| 1 | Critical | security | path/to/file.ts:NN | one-line description of the actual finding | Fix |
| 2 | Important | code-quality + SoC (2 agents agree) | path/to/file.swift:NN | one-line description | Fix |
| 3 | Minor | tests | path/to/file.test.ts | one-line description | Defer to follow-up |
| 4 | Minor | code-quality | path/to/file.ts:NN | cosmetic comment nit | Skip (low value) |

**Required columns:**
- **Source agent(s)**: which reviewer(s) flagged it. When 3+ agents independently flag the same item, list them all — that convergence is a strong "real bug" signal vs. one agent's stylistic preference. Surface the pattern so the user sees it.
- **File:line**: not just the filename. The user should be able to jump to the spot without re-reading every agent's report.
- **Disposition**: `Fix` / `Defer to follow-up` / `Skip (reason)`. Don't leave any finding without an explicit disposition.

After surfacing this table, proceed to Step 5 — the user has the context to interrupt if they disagree with your dispositions.

## Step 5 — Triage and resolve feedback

Collect all agent responses. Apply this triage:

| Severity | Action |
|----------|--------|
| **Critical** | Fix immediately before any merge |
| **Important** | Fix before merge; push back with reasoning only if reviewer is provably wrong |
| **Minor** | Fix if quick (< 5 min); note in PR if deferring |
| **Looks good** | No action needed |

For each fix: edit the file, commit to the same branch, push. Do **not** create new branches for review fixes — keep them on the same PR branch.

After all fixes are pushed, leave a comment on the PR summarising what was addressed and what (if anything) was intentionally deferred.

## Step 5.4 — Re-review the fix commits (REQUIRED before merge)

Once Step 5 is complete and the fix commits are pushed, dispatch **one more reviewer agent** scoped to the fix commits only. The initial review caught the issues; this pass catches mistakes in the *fixes* — wrong mock variable name, off-by-one in a regex change, a "fix" that swapped one bug for another, a status code change that broke a caller, etc. Skipping this is how you ship a fix that introduces a worse regression than the bug it closed.

Dispatch a single `superpowers:code-reviewer` agent with:
- The commit range `<base>..<head>` covering only the fix commits (not the original PR commits)
- The specific list of findings each fix was supposed to address (so the reviewer can verify intent vs. implementation)
- Test results post-fix (e.g. "1013 tests passing")

Treat the result the same as any review:
- **Critical / Important** → fix, push, **re-review again** (loop until clean)
- **Minor** → fix if quick, note if deferring
- **Looks good** → proceed to Step 6

Skip this step ONLY if the fixes were trivial and self-evidently correct (e.g. a single typo correction, a one-character config change). For everything else — code edits, rule changes, test changes, refactors — run it. The cost of one extra review (~30s) is much smaller than shipping a broken fix.

## Step 5.5 — Optional: visual smoke test (per surface)

A change can touch any combination of **web** (Next.js pages), **iOS** (Swift views), and **admin tools** (`src/app/admin/*`). For each surface the diff actually touches, offer a smoke test before merge — **don't conflate one surface's verification with another's**. "Tested on iOS" doesn't tell us anything about whether the web flow still works.

```bash
# Classify the diff into surfaces. Each variable is non-empty only if that surface is affected.
DIFF_FILES=$(git diff origin/main..HEAD --name-only)

# iOS UI changes — paths that affect rendering. `Views/` (with trailing slash, no `?`)
# avoids false-positives on `ViewModels/`. Components, Theme, the widget extension,
# and the *App.swift entry point all affect rendering.
# IMPORTANT: must be a single-line regex — BSD grep on macOS treats literal newlines
# inside `grep -E` as empty alternatives and aborts with "empty (sub)expression". GNU grep
# happens to tolerate it, which makes this an easy regression to introduce.
IOS_UI_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E 'ios/[^/]+/Views/.*\.swift$|ios/[^/]+/Components/.*\.swift$|ios/[^/]+/Theme/.*\.swift$|ios/[^/]+/App/.*App\.swift$|ios/TrainingLiveActivityWidget/.*\.swift$|ios/Packages/PhotoAILiveActivityShared/.*\.swift$|ios/.*Info\.plist$|ios/.*\.entitlements$' || true)

# Web user-facing pages (excludes API routes and admin). Done as include + exclude
# because BSD grep on macOS doesn't support PCRE negative lookaheads.
WEB_DIFF=$(echo "$DIFF_FILES" \
  | /usr/bin/grep -E "^src/app/.*\.(tsx|ts|css)$|^src/components/" \
  | /usr/bin/grep -v -E "^src/app/api/|^src/app/admin/" \
  || true)

# Admin tooling — separate surface from regular web.
ADMIN_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E "^src/app/admin/" || true)

# Also catch contentful iOS plist changes that don't show up in --name-only —
# additions/removals of plist keys that affect runtime behavior.
PLIST_KEY_DIFF=$(git diff -G "NSSupportsLiveActivities|CFBundleURLTypes|NSExtensionPointIdentifier" origin/main..HEAD --name-only -- "ios/**/*.plist" "ios/project.yml" || true)
```

For each non-empty surface, run that surface's verification:

### iOS surface (`IOS_UI_DIFF` or `PLIST_KEY_DIFF` non-empty)

1. **List candidate features.** `grep -li "^## visual smoke test" docs/features/*.md`. Show candidates and let the user pick — **don't reverse-engineer file→feature mappings**, the mapping is intentionally manual.
2. Prompt: *"iOS UI changed. Run `/qa` smoke test before merge? Available: [list]. Or 'skip'."*
   - **picks** → invoke `/qa <feature>`. **Pause merge on any ❌**.
   - **skip** → note the skip in the merge comment.
3. If no feature has a `## Visual smoke test` section, surface that gap and continue.

### Web surface (`WEB_DIFF` non-empty)

1. Prompt: *"Web pages/components changed. Run `/chrome` to smoke-test the affected flow before merge? Or 'skip'."*
   - **picks** → invoke `/chrome <path>` (default `/`) and walk the user-facing flow. Take screenshots of any visual changes. **Pause merge on any ❌** (broken render, console error, network failure).
   - **skip** → note in the merge comment.

### Admin surface (`ADMIN_DIFF` non-empty)

1. Prompt: *"Admin tools changed. Smoke-test the admin flow before merge? Or 'skip'."*
   - **picks** → boot dev server (`/chrome /admin` or whatever path is affected), exercise the admin action end-to-end (e.g., force-end an LA, flip a config flag, view a dashboard). Verify the action's side effect actually happens (Firestore write, log line, UI state change).
   - **skip** → note in the merge comment.

### Skip Step 5.5 entirely when:
- The diff is server-only (`src/lib/**`, `src/app/api/**`, `firestore.rules`) — unit tests are the verification, no rendered surface to check.
- A surface's diff is text-only / copy-only (run `git diff -U0 -- <files>` and inspect — if every hunk is just string changes, view-model tweaks, comment edits, skip that surface).
- The user has explicitly opted out of visual testing for this branch.

**On smoke-test failure (any surface):** state which surface failed, what was expected vs. seen, and pause — don't push fixes-while-broken. Leave the dev environment as-is so the user can inspect.

When in doubt, ask. The cost of a 30s confirmation prompt is much smaller than shipping a broken surface — and "I tested iOS" is not a substitute for "I tested web."

## Step 5.6 — Automated UI test coverage (iOS, REQUIRED for behavior changes)

Step 5.5's `/qa` is human-driven visual verification. This step is the *automated* counterpart: decide which existing XCUITest covers the changed flow (and run it), or write a new one if the behavior isn't covered. Catches regressions later when the human running `/qa` doesn't.

The XCUITest stack lives at `ios/DatingAIAssistantUITests/`, runs via `./scripts/run-ui-tests.sh <ClassName>` — it mints a Firebase custom token, signs in as the QA user, then drives the app. Page objects in `TestSupport/Pages/` centralize locators per screen.

### When to skip Step 5.6 entirely

- `IOS_UI_DIFF` from Step 5.5 is empty (no iOS UI files touched)
- The diff is purely text/copy/color/padding — no behavior change. Snapshot tests will cover these once Phase 2 lands; for now, note in the merge comment.
- Server-only diffs (`src/lib/**`, `src/app/api/**`, `firestore.rules`) — unit tests / rules tests are the verification.

### When 5.6 IS required

The diff modifies user-driven behavior on iOS — a new flow, a new control, changed validation, changed navigation, changed alerts/dialogs. Even small behavior changes count if the flow has a user-tappable path through it.

### Step 5.6.1 — Decide: write new vs. update existing

Map the changed views/flows to existing UITest classes:

```bash
# Find UITests that reference the changed views by name. The page-object
# pattern means tests interact via Pages/<Screen>Page.swift, so changes
# to (say) DashboardEmptyView.swift correlate with tests that use
# DashboardPage. Catch both direct references and page-object usage.
for view in $(echo "$IOS_UI_DIFF" | xargs -n1 basename | sed 's/\.swift$//'); do
  echo "=== $view ==="
  /usr/bin/grep -lE "$view|${view%View}Page" ios/DatingAIAssistantUITests/**/*.swift 2>/dev/null
done
```

Then triage:

| Situation | Action |
|---|---|
| Grep finds existing UITest covering the flow | **Update** if the test's expectations change; otherwise just **run** it |
| Grep finds nothing AND the change adds a new flow / new alert / new tappable affordance | **Write** a new UITest. Add a page object if the screen doesn't have one yet |
| Grep finds nothing AND the change is to internals (a viewmodel method, a private var) reached by an existing flow | **Run** the existing UITest that exercises that flow |
| Diff is pure visual (color, padding, copy) | Skip — note in merge comment that snapshot tests should cover it once Phase 2 is wired |

**Don't overdo it.** A UITest exists to catch *future* regressions in user-driven behavior. If the change has no user-tappable surface area (pure styling, internal refactor reachable through an existing tested flow, copy-only change), skip writing one — note the skip in the merge comment. Better one tight test that runs reliably for a year than three flaky tests that get disabled in two months.

When writing a new UITest:
- Start from `LoginFlow.launchSignedIn()` — that's the one-liner setup that puts the AUT on the dashboard with a real Firebase session.
- Locate UI elements via page objects; add `.accessibilityIdentifier(...)` to the source view if a needed element doesn't have one yet (don't change `.accessibilityLabel` — that's what VoiceOver speaks).
- One assertion per test; split if you find yourself asserting four things.
- No sleep — use `waitForExistence(timeout:)`.
- See `ios/DatingAIAssistantUITests/README.md` for conventions.

### Step 5.6.2 — Run

Run the relevant test(s) via the wrapper:

```bash
# Single class — preferred when the change is scoped
./scripts/run-ui-tests.sh AuthSmokeTests

# Full suite — when the change is broad or you wrote new tests
./scripts/run-ui-tests.sh
```

The wrapper mints a fresh custom token each run (1h TTL) and forwards it through the test plan; no manual setup beyond `FIREBASE_SERVICE_ACCOUNT_KEY` in `.env.local`.

### On UITest failure

Pause merge. Triage:

- **Test reveals a real regression** → fix the code, push, re-run before merge.
- **Test is brittle (locator drift, timing)** → fix the *test*, not the code. Push the fix to the same PR branch.
- **The behavior changed intentionally and the test's expectation is now outdated** → update the test to assert the new contract.

Don't merge with a failing UITest "to be fixed later" — it always rots. The cost of one more iteration on the PR is much smaller than shipping a regression that the test would have caught next week.

## Step 5.7 — Self-test the change end-to-end (REQUIRED for behavior changes)

Approaching production: unit tests + reviewer agents catch most things, but actually exercising the code path catches what only running code can show — wrong env var name, broken auth, malformed response shape, missing CORS, the route returns 200 but the body is wrong, the iOS sim talks to the wrong host.

### When 5.7 IS required

Anything where running the code in a real environment is a stronger signal than reading the diff:

- **New or modified API route** (`src/app/api/**`) — must be hit live.
- **New or modified server-side service** that an existing route uses — exercise the route that consumes it.
- **iOS code that calls a server endpoint** — point the sim at localhost dev server and drive the flow (covered by /qa or manual sim drive).
- **Webhook handler change** (Apple notifications, IAP, refund) — must be invoked, ideally with a captured real payload replayed via `curl`.
- **Anything that touches credits, billing, or generation cost** — exercise both success and failure paths and confirm the credit ledger ends in the right state.
- **iOS animation / transition code** — diff touches `matchedGeometryEffect`, `withAnimation`, `.transition`, `.animation`, `@Namespace`, `NavigationTransition`, `.zoomTransition`, or any `Animation.` call site. Build passes and end-state screenshots are not enough — a broken animation often settles on a visually-correct final frame.

### When to skip 5.7

- Pure refactor with unit-test coverage — tests are the verification.
- Copy/styling/asset-only change.
- Already verified by Step 5.5 (`/qa` or `/chrome`) end-to-end exercise.
- Server-only diff with full unit-test + rules-test coverage of the new logic.

### How to run it

For API routes:

```bash
# Boot dev server if not already up.
npm run dev

# Hit the endpoint. Capture status, headers, body. Include realistic params.
curl -sS -X POST http://localhost:3000/api/<route> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token-if-auth-required>" \
  -d '{...realistic body...}' \
  -i | head -50
```

Verify:
- HTTP status matches what the client expects.
- Response shape matches what callers parse — field names, types, optionality.
- Error paths return the right status (401 unauth, 403 forbidden, 400 validation, 500 only for genuine server errors).
- Side effects landed: check the relevant Firestore doc, log line, or downstream record.
- Credit ledger is in the expected state (was a credit deducted? was it refunded on failure?).

For iOS that hits server: confirm the sim is pointing at the local dev server (or staging), drive the flow, watch dev-server logs for the inbound request, watch Xcode console for the response.

For iOS animation changes: drive the affected flow in the sim and **observe the transition play through** — start state → in-flight motion → end state. A single screenshot of the end frame is not a verification (a broken animation can still settle on a correct-looking final frame). Use `/qa <feature>` if a smoke test exists; otherwise drive the sim with computer-use and screen-record the transition. If neither is possible, ask the user to play it back before merge. Describe the motion across time when reporting back, not a still from the recording — "the hero card scales smoothly from 200pt to fullscreen over ~0.4s" is a verification; "the end frame shows the photo fullscreen" is not.

### When you can't run it yourself — ASK

Some verifications need things the agent doesn't have:

| Situation | Ask the user |
|---|---|
| Need a signed-in user state on web | *"I need an authenticated browser session to hit this endpoint. Want me to walk you through it with `/chrome`, or can you run the curl for me?"* |
| Need to drive the iOS simulator | *"Want me to run `/qa <feature>` or use computer-use to drive the sim and verify? Either way, this needs to be exercised before merge."* |
| Need real IAP receipts / App Store sandbox state | *"This touches IAP receipt validation. I can't exercise it without sandbox state. Can you run the purchase flow on TestFlight and confirm the credit ledger lands correctly?"* |
| Need production-only services (live APNs, real Apple webhook) | *"This webhook code only fires in production. Want me to ship behind a feature flag and verify in prod, or wait to merge until we can replay a captured payload here?"* |

**Don't fake the verification.** "I read the code and it looks right" is not a verification — that's what the reviewer agents already did. If you can't actually run the code path and observe its behavior, say so explicitly in the merge comment so the user can decide whether to verify manually before merge.

### On 5.7 failure

Pause merge. State exactly what was expected vs. observed (status code, body, side-effect). Don't push a fix until the user confirms the diagnosis — these are often environmental (wrong env var, stale dev server, missing seed data) and don't need code changes.

## Step 5.8 — Build gate: `next build` (REQUIRED for any TypeScript change)

**Why this step exists:** vitest tests mock-out the call boundary, so a mock returning the wrong shape doesn't fail a test. `next build` runs strict TypeScript across the production pipeline — it catches type mismatches that runtime tests paper over. We learned this the hard way: PR #371 ($367's `runEdit` extraction declared `RunEditResult.imageURL: string` but the provider actually returns `{ imageId, downloadURL }` — tests passed, deploy failed, prod 404'd on every quick-fix call until a follow-up hotfix landed). Vitest + lint are not enough.

### When to skip Step 5.8

- Diff is documentation-only (`docs/`, `*.md` files) — no TS to type-check.
- Diff is iOS-only (`ios/...`) — Xcode build catches Swift type errors; `next build` is irrelevant.
- Diff is skill / config / asset files (`.claude/skills/`, `.env*`, JSON catalogs) with no associated TS — nothing to compile.

In any other case (`src/**/*.ts(x)`, `next.config.*`, `middleware.ts`, route handlers, components, hooks, services, scripts/*.ts), **run it**.

### Run

```bash
npm run build 2>&1 | tail -30
```

Expected: `Compiled successfully` followed by the route table, exit code 0. **No `Type error` / `Failed to type check` / `Build process exited with error code` output.**

The build takes 30-60 seconds on a warm cache (it shares `.next/` with the dev server). Run it in the background while you're doing other verification — don't block on it.

### On failure

A real `Type error` from `next build` is a Critical finding equivalent — same severity as a security bug, because production won't deploy. Treat it as:

1. **Stop the merge.**
2. Read the error. The format is:
   ```
   ./path/to/file.ts:LINE:COL
   Type error: <message>
   ```
3. Fix the type at its source (don't `// @ts-ignore`, don't `as unknown as Foo` cast). The fix usually means aligning a declared interface with what's actually returned/produced — most often the issue is a mock-driven test that hid the mismatch from vitest.
4. After fixing, **re-run `npm run build`** to confirm green, then **re-run the affected vitest suites** because the type change may have invalidated mocks.
5. Push the fix as another commit on the same PR branch.

### Don't bypass

- Never merge a PR that fails `next build`. App Hosting auto-deploys on main and a failing build means production is stuck on the previous revision. Subtle: the previous revision keeps serving traffic indefinitely, so the symptom is "feature doesn't work in prod" not "site is down" — easy to miss without checking deploy status.
- Never `--admin`-bypass the gate to merge through a failing build with the intent to fix later. The intent never materializes; the bug ships.

## Step 5.9 — Build gate: `xcodebuild` (REQUIRED for any iOS Swift change)

Parallel to Step 5.8's `next build` for the web, this is the iOS equivalent. Catches compile errors that vitest-style unit tests can't see — Swift type errors, missing imports, **duplicate declarations** (you'd be surprised), `@MainActor` boundary violations.

**Why this step exists:** we shipped PR #371 with a duplicate `private func runQuickFix` in `ImageDetailView.swift` — squash-merge artifact from a PR-branch that forked from the same worktree the iOS PR shipped from. The duplicate sat on `main` for 30+ minutes before anyone noticed because we kept building from the *worktree* (which had a single copy) instead of from main. A clean build catches this class in seconds.

### When to skip Step 5.9

- Diff is web-only (`src/**`, `firestore.rules`, `scripts/**`) — no Swift touched.
- Diff is documentation, assets, plists, or `project.yml` changes that don't affect compilation.
- Diff is pure asset-catalog changes (new `*.imageset`, `*.colorset`) — Xcode resolves these at run time, not at compile.

In any other case (`ios/**/*.swift`, `ios/project.yml` with new source paths, anything touching the SwiftPM Package.swift, target settings, or build phases), **run it**.

### Run

**Worktree note:** if `/doit` is running from a worktree (almost always — `/doit` typically creates a feature branch under `.claude/worktrees/`), the `../../saas-template/...` SPM paths in `ios/project.yml` don't resolve. Symlink the peer location first (same pattern `/chrome` uses for `.env.local`):

```bash
WORKTREE_ROOT=$(git rev-parse --show-toplevel)
GIT_COMMON_ABS=$(cd "$WORKTREE_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
PARENT_REPO=$(dirname "$GIT_COMMON_ABS")
if [ "$PARENT_REPO" != "$WORKTREE_ROOT" ]; then
  SAAS_SOURCE="$(dirname "$PARENT_REPO")/saas-template"
  SAAS_PEER="$(dirname "$WORKTREE_ROOT")/saas-template"
  [ -d "$SAAS_SOURCE" ] && [ ! -e "$SAAS_PEER" ] && ln -s "$SAAS_SOURCE" "$SAAS_PEER"
fi
```

Then:

```bash
cd ios && xcodebuild \
  -project DatingAIAssistant.xcodeproj \
  -scheme DatingAIAssistant \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=iPhone 17" \
  -derivedDataPath /tmp/datingai-sim-build \
  build 2>&1 | tail -10
```

Expected: `** BUILD SUCCEEDED **`. The shared `/tmp/datingai-sim-build` cache is the same one `/simulator` uses, so this is usually 15-30s on a warm build.

### On failure

Treat as Critical equivalent — same severity as a security bug. iOS doesn't auto-deploy on main (TestFlight is a manual `xcodebuild archive` step), so a broken main doesn't immediately ship to users, but it does block:

- Any other branch that gets rebased on or merges from main
- Anyone running `/simulator` after pulling main
- The next TestFlight cut

Fix the same way as any build failure: read the error, fix the underlying issue (don't `@available(*, unavailable)` your way past it), re-run the build, commit, push. If the error is a **duplicate declaration** like the one PR #371 introduced, double-check the PR's diff against `origin/main` for any code that's already there — that's the squash-merge artifact pattern.

### Subtle: pre-merge gate vs. post-merge verification

`xcodebuild` from the worktree (this step) validates the **PR branch state**. It does NOT catch squash-merge artifacts that only appear in the merged-into-main result. For full safety, also do a post-merge sanity check (see Step 6).

### Don't bypass

- Never push the merge button on a PR whose iOS files fail `xcodebuild`. Use the same "Critical → fix → re-run → commit → push" loop you would for any other Critical finding.

## Step 6 — Merge

Once all Critical and Important issues are resolved:

```bash
gh pr merge <PR-number> --squash --delete-branch
git checkout main
git pull --ff-only origin main
```

If multiple PRs exist, merge them in dependency order. If they're independent, merge whichever is reviewed-and-clean first.

### Post-merge iOS verification (REQUIRED when iOS files were merged)

Squash-merge can produce code that **doesn't exist in either side individually** — a function declared in both the PR-branch and main (via an earlier merge) lands twice in the squashed result. Pre-merge `xcodebuild` (Step 5.9) catches in-branch errors but not this. Once main is updated:

```bash
git checkout main && git pull --ff-only origin main
cd ios && xcodebuild \
  -project DatingAIAssistant.xcodeproj \
  -scheme DatingAIAssistant \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=iPhone 17" \
  -derivedDataPath /tmp/datingai-sim-build \
  build 2>&1 | tail -10
```

Expected: `** BUILD SUCCEEDED **`.

If it fails:

1. Inspect the failure (likely a duplicate declaration or a missed import from the squash).
2. Push a hotfix commit directly to `main` immediately — App Hosting will keep the previous Next.js revision serving traffic (web is safe), but the broken iOS state blocks everyone else's pull-rebase-build cycle. The window between bad merge and hotfix should be measured in minutes, not hours.
3. The hotfix can use the GitHub Contents API (`gh api PUT /repos/.../contents/<path>`) if branching is awkward — the duplicate-`runQuickFix` fix was done this way.

Skip this verification when the merged PR touched zero iOS Swift files.

## Step 7 — Report

Output a structured report in this exact shape — the user should be able to grade the entire shipping cycle from one scroll.

### Merged

| PR | Title | Merge commit |
|---|---|---|
| #N | <title> | [<sha>](https://github.com/aryaxt/photo-ai/commit/<sha>) |

### Review findings + resolutions

| Severity | Source agent(s) | Finding | Resolution |
|---|---|---|---|
| Critical | <agents> | <one line> | Fixed in commit <sha> |
| Important | <agents> | <one line> | Fixed in commit <sha> |
| Minor | <agents> | <one line> | Deferred / Skipped (with reason) |

### Verification

| Gate | Status |
|---|---|
| Unit tests (vitest) | <N passing / N failing> |
| Rules tests | <ran / skipped — why> |
| iOS build | <SUCCEEDED / FAILED / N/A> |
| iOS UITest (Step 5.6) | <ran / skipped — why> |
| Visual smoke test (Step 5.5) | <ran / skipped — why> |
| CI workflow on the merged PR | <green / red — link / didn't run — why> |

### Deferred to follow-up

Bullet list of anything intentionally punted, with one-line reason each. Empty list is fine — say so explicitly.

Use real data from this run. Don't fabricate gate statuses; if you skipped a gate, say "skipped (reason)" — that's how the user catches process drift.

## Step 8 — End-of-session safety check

After the report, inspect the current branch's working tree and tell the user whether it's safe to close the session. *Safe* = no uncommitted code that would be lost.

```bash
git status --porcelain
git stash list
```

**Triage every line from `git status --porcelain` into one of three buckets:**

| Bucket | What it is | What to say |
|--------|------------|-------------|
| **Noise (ignore)** | Auto-generated, ephemeral, or local-only files: `.claude/settings.local.json`, `.claude/scheduled_tasks.lock`, `.claude/worktrees/`, `*.xcuserstate`, `DerivedData/`, OS detritus (`.DS_Store`), editor swap files. Also any pre-existing untracked files that were already present before the session started. | Mention them by name in one line, mark as safe to leave. |
| **Real but unwanted** | Edits or new files that exist because of in-session experimentation but the user clearly does NOT want to keep — e.g. debug `print` statements you added, scratch files, half-broken explorations the user told you to abandon. | Tell the user what they are and propose discarding (`git checkout -- <path>` or `rm <path>`). Do NOT discard without confirmation. |
| **Real and worth keeping** | Source edits, tests, docs, or new files that look intentional and aren't already on a PR. | NOT safe to close. Tell the user what's uncommitted and ask whether to commit, stash, or discard. |

Also call out:
- **Stashes created during this session** (compare `git stash list` against what was there at session start, if you can tell). Stashes survive across sessions but they're easy to forget. If you created any during /doit (e.g. for a split), confirm they were dropped.
- **Branches still checked out** in worktrees that aren't `main`. Not unsafe per se, but worth flagging if the user expects to come back to them.

**Final verdict format** — give the user one of these three lines:

- ✅ **Safe to close.** Working tree is clean (or only contains noise: `<list>`).
- ⚠️ **Safe to close, but cleanup recommended.** Unwanted in-session changes still in tree: `<list>`. Run `<command>` to discard.
- 🛑 **Not safe to close.** Uncommitted work that would be lost: `<list>`. Decide: commit / stash / discard?

Be specific — list the actual paths, not vague descriptions. The user should be able to act on the verdict without further investigation.

---

## Step 1.5 — Sanity-check: does the code make sense?

Before doing anything else, read the changed files and ask:

**Is this code complete and coherent?**

Look for these signals that it is NOT:

| Signal | What to do |
|--------|------------|
| Functions/classes that only have a signature and no body (or just `// TODO`) | Stop and ask |
| Placeholder values like `"YOUR_API_KEY"`, `"TODO"`, `0`, `""` where real data is expected | Stop and ask |
| Files that are clearly stubs — imports and a struct/class with no logic | Stop and ask |
| Logic that references symbols, types, or modules that don't exist anywhere in the repo | Stop and ask |
| Code that would obviously crash or fail to compile on first run | Stop and ask |
| A feature that is clearly half-done — some views/routes added but the wiring is missing | Stop and ask |
| Changes that make no sense in context of what the user asked for | Stop and ask |

**If any of these are true, do not proceed.** Show the user the specific file and lines that look incomplete or wrong, explain why it concerns you, and ask:

> "This code looks incomplete / doesn't make sense to me in context. Here's what I'm seeing: [specific examples]. Did you mean to include this, or should I skip it?"

Wait for an explicit answer before proceeding.

**If the code looks complete and intentional**, continue to Step 2 without comment — don't narrate the sanity check if it passes.

---

## Red flags — stop and ask the user

- Uncommitted changes that look like work-in-progress (TODO comments, debug prints, commented-out code blocks) — ask before including
- Changes that touch migration files or schema — confirm before merging
- A branch that's already open as a PR on GitHub — don't create a duplicate
- More than ~5 natural split points — something is wrong; ask the user what they actually want to ship
