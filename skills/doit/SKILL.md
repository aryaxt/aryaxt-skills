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

### Pre-flight: worktree dependency install (REQUIRED in a worktree)

`/doit` almost always runs from a feature branch under `.claude/worktrees/`. A fresh worktree has **no `node_modules` of its own** — and because it's nested inside the main repo, Node's module resolution walks UP and silently falls back to the **main repo's** `node_modules`, which was installed on a *different branch*. If this branch declares newer deps than that branch had installed (a new vendored `@aryaxt/*` package, an SDK bump, a new dependency), every downstream step that runs code resolves the **wrong, stale deps** — the first `git push` below fires the pre-push hook (`npm run test:all`) against them, and `next build` (5.8) / the unit-test gate (5.8b) / the dev server (5.7) all inherit the mismatch.

We hit this concretely: a worktree branch that pulled in `@aryaxt/app-gate` (added to the app on a later `main` than the main clone's checked-out branch) ran its whole suite against the main repo's older `node_modules`, which had no `@aryaxt/app-gate` and a stale `@aryaxt/error-reporting` — **52 suites failed at import** with `Cannot find package '@aryaxt/app-gate'`. The tests were fine; the *install* was wrong. This is the web analog of the Step 5.9 iOS saas-template-symlink pre-flight and `/chrome`'s `.env.local` symlink.

Run this **before the first `git push`** (the push triggers the pre-push test hook), and never symlink the worktree's `node_modules` to the main repo's — that's the wrong branch's copy:

```bash
WORKTREE_ROOT=$(git rev-parse --show-toplevel)
GIT_COMMON_ABS=$(cd "$WORKTREE_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
PARENT_REPO=$(dirname "$GIT_COMMON_ABS")
# Only act in a worktree (parent repo differs from the working root) and only for web projects.
if [ "$PARENT_REPO" != "$WORKTREE_ROOT" ] && [ -f "$WORKTREE_ROOT/package.json" ]; then
  # Sentinel: a vendored/declared package that should resolve to THIS worktree's own node_modules.
  # Pick any @aryaxt/* the branch declares; app-gate is the canonical recent one.
  if [ ! -e "$WORKTREE_ROOT/node_modules/@aryaxt/app-gate/package.json" ] && grep -q '@aryaxt/app-gate' "$WORKTREE_ROOT/package.json"; then
    echo "Worktree node_modules missing/stale — installing this branch's deps…"
    ( cd "$WORKTREE_ROOT" && npm install )   # ~20s; materializes file: vendored @aryaxt/* via install-links=true
  fi
fi
```

It's incremental-fast (~20s warm) and usually leaves `package-lock.json` unchanged (nothing to commit). If `git status` shows a lockfile diff, that's a real dep drift — commit it with the PR. CI (`npm ci` fresh) is unaffected; this gap only bites local worktree runs.

**On a failing pre-push hook (`npm run test:all`), DIAGNOSE before you `--no-verify`.** Mass import-time failures across unrelated suites (`Cannot find package …`, `X is not a function` from a vendored package) are the signature of *this* stale-`node_modules` problem, not real test breakage — the fix is the `npm install` above, not a bypass. `--no-verify` defeats the only unit-test gate `/doit` actually relies on (the hook); reach for it only once you've confirmed the failures are genuinely pre-existing and unrelated to the deps.

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

## Step 3.5 — Backward compatibility check (before review)

🚨 **The app is live in production.** Older iOS app binaries that real users have installed can't be force-updated, and persisted Firestore docs from old clients keep being read by every new release. Per AGENTS.md "🚨 EXTREMELY IMPORTANT — production is live, no breaking changes", any diff that breaks the existing server contract or persisted-data shape must be flagged here and renegotiated with the user — **not silently shimmed away with `if (newField)` branches**.

Scan the diff for the surfaces that have live-client implications:

```bash
DIFF_FILES=$(git diff origin/main..HEAD --name-only)

# Server contract — API routes, services that build response payloads, shared DTOs
CONTRACT_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^src/app/api/.*route\.ts$|^src/lib/services/|^src/lib/ai/providers/|^src/types/' || true)

# Persisted data — rules, indexes, and any code with a Firestore write call
RULES_INDEX_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^(firestore|storage)\.(rules|indexes\.json)$' || true)
WRITE_DIFF=$(git diff origin/main..HEAD -G "addDoc|setDoc|updateDoc|collection\(|doc\(|Firestore\.firestore|db\.collection" --name-only || true)

# iOS↔server DTOs — Swift models that mirror server JSON shapes
IOS_DTO_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^ios/[^/]+/Models/' || true)

# Android↔server DTOs — Kotlin @Serializable data classes that mirror server JSON shapes
ANDROID_DTO_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^android/.*/data/models/' || true)

# Money surfaces — IAP products, credit grants, App Store webhook handling
MONEY_SHAPE_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E 'iap-products|credit-service|apple-notifications|webhook|refund' || true)
```

If every variable is empty, skip this step. Otherwise classify each hunk:

| Change | Verdict |
|---|---|
| Renamed/removed a field on an existing Firestore doc that older iOS builds read or write | **Breaking** |
| Renamed/removed/retyped a field in an HTTP API request or response that older iOS builds send/parse | **Breaking** |
| Removed or renamed an API route the live iOS app calls | **Breaking** |
| Tightened input validation on an existing route in a way that rejects payloads the old iOS client still sends | **Breaking** |
| Renamed/removed an analytics event the live iOS app emits | **Breaking** |
| Changed IAP product IDs, App Store webhook handling, or per-product credit grants | **Breaking** (money + entitlement implications) |
| Added a new *optional* field to a request, response, or Firestore doc | Not breaking |
| Added a new API route, new analytics event, or new enum value clients treat as unknown gracefully | Not breaking |
| Pure UI / internal refactor with no contract surface | Not breaking |
| Server-only change with an iOS counterpart in the same PR | Not breaking ONLY if the iOS change has already shipped to production AND the minimum-supported-build floor is raised AND the PR description states this explicitly |

**If you find ANY Breaking row** — STOP. Do NOT auto-fix by adding `if (newField)` shims or "accept both shapes forever" fallbacks. Surface a large, unmissable alert and wait for the user:

```
⛔️⛔️⛔️ BREAKING CHANGE DETECTED ⛔️⛔️⛔️

File:line      : <path>:<line>
What's breaking: <exact field / route / shape change>
Who it breaks  : <e.g. iOS builds < 1.x.y in the App Store; existing users/{uid}/photos docs; in-flight web sessions>
Why a quick conditional shim is NOT the answer:
  - <e.g. compounds versioning debt forever — every future change has to carry the branch>
  - <e.g. doesn't help iOS clients reading the renamed Firestore field — they still get nil>

How would you like to proceed?
  1) Ship anyway — forced-update release is queued / I accept the breakage
  2) Defer until the next forced-update release (re-scope the PR)
  3) Design a real migration (additive field → dual-write → backfill → dual-read → cut over with a kill date)
  4) Re-scope the change to be purely additive
```

Once the user picks a path, record the decision in the PR description's `## Notes` section — and if a migration was chosen, include the dual-write / dual-read / cut-over plan with a stated kill date.

If everything classifies as **Not breaking**, state that explicitly in the PR description's `## Notes` ("Backward-compatible: <one-line reason>") and continue to Step 3.6. Silent compatibility claims are how regressions ship — the **Backward compatibility** reviewer agent in Step 4 will look for this note.

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

Per AGENTS.md "Cross-Platform Parity" and the project's mobile-first convention: user-facing features must reach every platform they belong on — **web, iOS, and Android** — with the same naming, same content, same server contract. Drift starts when a feature ships on iOS and "we'll do web/Android later" silently rots.

**iOS ↔ Android structural parity:** the Android app is a 1:1 native mirror of the iOS app (see `docs/features/android-parity.md`). When a change touches an iOS file that has an Android counterpart (or vice-versa), the same logic belongs on both — parity is enforced at the server-contract level, and the file structure mirrors (`ios/.../Views/Foo.swift` ↔ `android/.../ui/.../FooScreen.kt`, `ViewModels/FooViewModel.swift` ↔ `viewmodels/FooViewModel.kt`). Per the project's mobile-first ordering, iOS still leads; Android follows feature-by-feature.

Classify the change:

| Type | Action |
|---|---|
| Bug fix or refactor scoped to one platform | Fine — single-platform is correct. |
| New user-facing feature on iOS only (project is mobile-first) | iOS-first is correct. **But before merge**, file follow-up GitHub issue(s) tracking the **web AND Android** counterparts, with the iOS PR linked. Include slot IDs, scene IDs, copy strings, and the server contract so the other platforms don't drift. |
| New user-facing feature on web only | Justify — usually this is wrong direction per mobile-first. Ask the user before merging unless the feature is web-native (admin, marketing, onboarding email landing, etc.). |
| New user-facing feature on Android only | Justify — Android follows iOS, it doesn't lead. Almost always the iOS version should exist first. Ask the user unless this is an explicit Android-port catch-up of an already-shipped iOS feature. |
| A feature changed on iOS that has an Android counterpart (or vice-versa) | The change should land on both — same logic, mirrored file. If only one side is in the diff, either include the other or file a tracking issue and say so explicitly in the PR. |
| Server change (new field, new endpoint, new behavior) without matching client changes | Confirm all clients (web, iOS, Android) can consume the new contract — or that the change is purely additive and backwards-compatible. |
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

## Step 3.10 — Cross-repo / cross-branch dependency check (before review)

A change rarely lives in one repo. When this change **depends on code that only exists in an unmerged PR somewhere else**, merging this PR alone ships a consumer pointing at something that isn't on the other side's `main` yet — `main` breaks, deploys get stuck, or installed clients reference an export/skill/route that doesn't exist. The whole point of this step is to make those dependencies explicit **before** review, so the merge in Step 6 can be gated on them.

### Detect sibling-repo work FIRST (don't rely on memory)

The recurring failure this prevents: edits land in a sibling repo (`saas-template`, `aryaxt-skills`) during the session, the app PR merges, and the sibling work is left as an **uncommitted-or-orphaned local branch** that never ships — the sibling repo drifts out of sync and piles up dead branches (we've hit 39 in `saas-template`). "The agent forgot it touched a sibling repo" is the root cause, so **check explicitly** instead of recalling:

```bash
WORKTREE_ROOT=$(git rev-parse --show-toplevel)
GIT_COMMON_ABS=$(cd "$WORKTREE_ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
REPOS_DIR=$(dirname "$(dirname "$GIT_COMMON_ABS")")   # the folder holding all sibling clones

for sib in saas-template aryaxt-skills; do
  SIB="$REPOS_DIR/$sib"
  git -C "$SIB" rev-parse --git-dir >/dev/null 2>&1 || continue
  BR=$(git -C "$SIB" rev-parse --abbrev-ref HEAD)
  # Ignore build/dep noise (.build/, node_modules/, the generated android/ mirror)
  DIRTY=$(git -C "$SIB" status --porcelain | /usr/bin/grep -vE '\.build/|node_modules/|^\?\? android/' || true)
  AHEAD=$([ "$BR" != main ] && git -C "$SIB" log --oneline main.."$BR" 2>/dev/null || true)
  if [ -n "$DIRTY" ] || [ -n "$AHEAD" ]; then
    echo "⚠️  $sib has unshipped work (branch=$BR) — it MUST ship before the app PR:"
    [ -n "$DIRTY" ] && { echo "  uncommitted:"; echo "$DIRTY" | sed 's/^/    /'; }
    [ -n "$AHEAD" ] && { echo "  commits ahead of main:"; echo "$AHEAD" | sed 's/^/    /'; }
  fi
done
```

If this prints anything for a sibling repo, treat that repo's change as a **hard dependency PR** (rows below): it must be committed, PR'd, reviewed, and **merged before the app PR**, then pulled into the app (`vendor:refresh` for `@aryaxt/*` / Xcode reads the SPM live / `/plugin update` for skills). Never merge the app PR against uncommitted or unmerged sibling work. Record it under `## Notes` and carry it into the Step 6 hard gate.

### Sibling lifecycle: fresh-main at rest, edits in a worktree

The invariant that stops drift: **a sibling repo's primary checkout always sits on a clean, current `main`.** It is a dependency consumed by filesystem path — never a scratchpad. So:

- **At rest / feature start** — the primary checkout is on `main`. If the detection above shows it parked on a feature branch or holding stray edits, that's drift: get it back to `main` (`git -C <sib> checkout main && git -C <sib> pull --ff-only`) *unless* those edits are this feature's in-flight sibling work (then move them into a worktree, below). Never start new work on top of a dirty sibling main.
- **When THIS feature needs a sibling edit** — don't mutate the primary checkout. Cut a **worktree off fresh `origin/main`** and edit there, so the primary checkout stays clean and on `main`:

  ```bash
  SIB=~/Desktop/Repos/<sibling>          # saas-template | aryaxt-skills
  git -C "$SIB" fetch -q origin
  WT="${SIB}-wt"                          # sibling worktree lives beside the clone
  git -C "$SIB" worktree add "$WT" -b <descriptive-branch> origin/main
  # …make the change inside $WT…
  ```

- **Wire the app build to the worktree** so the in-flight change is actually exercised (the two consumption modes differ):
  - **NPM / vendored `@aryaxt/*`** → `SAAS_TEMPLATE_DIR="$WT" npm run vendor:refresh` (reads from the worktree instead of the default clone).
  - **iOS SPM** (`ios/project.yml` reads `../../saas-template/...` live) → repoint the peer symlink that the Step 5.9 pre-flight manages at the worktree: `ln -sfn "$WT" "$(dirname "$(git rev-parse --show-toplevel)")/saas-template"`. The Xcode build then compiles against the worktree. (This only works from an app worktree — which `/doit` always is — because that's where the peer symlink seam exists.)
  - **Plugin skills (`aryaxt-skills`)** → no live wiring; the change takes effect after merge, via the plugin-cache refresh in Step 6 ("Refresh the local plugin cache after ANY `aryaxt-skills` merge").

Step 6 ships the worktree branch and then **removes the worktree, returning the sibling to a pure `main`**. Don't skip the worktree and edit the primary checkout in place — that's exactly how the repo ends up parked on a feature branch with a pile of orphaned local branches.

Ask: **does landing this change require a change that is currently an open PR (or uncommitted work) in another repo or another branch?** Common dependency shapes in this setup:

| Dependency shape | The tell | What must land together |
|---|---|---|
| **Shared / template package** (saas-template SPM like `Components`/`Auth`, an `@aryaxt/*` NPM, a sibling monorepo package) | This change imports a symbol/export/prop that was just added in the package and isn't on the package's `main` yet | The package PR **and** this consumer PR |
| **Vendored dependency** (`vendor/…` copies of `@aryaxt/*`) | You edited the upstream package and this change consumes the new export — but the `vendor:refresh` + lockfile diff isn't in this PR | The upstream package PR, the `vendor:refresh` commit, **and** this consumer — all together, or `next build` fails with `export X was not found` |
| **Plugin / shared skill** (the `aryaxt-skills` plugin, a shared config) | This change relies on a skill, gate, or config that was hand-edited or PR'd in the plugin but isn't on the plugin's `main` | The plugin PR (then `/plugin update`) before this consumer is relied upon |
| **Sibling feature branch** | This branch was cut from another feature branch, or needs a route/migration/flag that lives in a different open PR | The prerequisite PR first, then this one rebased onto the merge |
| **Server ↔ client contract split across PRs** | The server PR adds a field/route this client PR consumes (or vice-versa) | Order so the **producer merges first**; never merge the consumer against a contract that isn't live |

**Enumerate every dependency PR by number/branch** (with the repo it lives in) and record them in this PR's description under `## Notes` — e.g. `Depends on: aryaxt/saas-template#88 (Components prop), vendor:refresh in this PR`. A reviewer (and future-you) must be able to see the full landing set.

**The rule:** never merge this PR while a dependency PR is still open. Either (a) merge the dependency first, pull it into this change's base (rebase / `vendor:refresh` / `/plugin update`), re-run the build gate so this PR is verified against the *merged* dependency, then merge this PR — or (b) if the dependency can't land yet, **defer this PR** and say so. Step 6 enforces this as a hard gate.

If there are **no** cross-repo/cross-branch dependencies, state that in `## Notes` ("Self-contained: no external dependency PRs") and continue.

## Step 3.11 — Analytics instrumentation check (before review)

A new user-facing feature/flow that ships **without analytics** is a feature we
can't tell is working; a **new event parameter** that ships without a matching
GA4 custom dimension is silently un-analyzable (GA4 won't let you break down by an
unregistered param, and registration is **not retroactive**). Both are easy to
forget. Full rules: the project's analytics doc (linked from AGENTS.md, e.g.
`docs/analytics-instrumentation.md`).

```bash
DIFF_FILES=$(git diff origin/main..HEAD --name-only)
# Did this diff add/change a user-facing feature/flow/screen/CTA on any platform?
FEATURE_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^(src/app/|src/components/|ios/.*/Views/|android/.*/ui/)' || true)
# Did it touch the analytics layer on any platform?
ANALYTICS_FILES=$(echo "$DIFF_FILES" | /usr/bin/grep -E '(firebase/analytics\.ts|Services/AnalyticsService\.swift|services/AnalyticsService\.kt)' || true)
# New event parameter keys introduced (added lines in the analytics files)?
NEW_PARAMS=$(git diff origin/main..HEAD -- '*AnalyticsService.swift' '*AnalyticsService.kt' '*firebase/analytics.ts' \
  | /usr/bin/grep -E '^\+' | /usr/bin/grep -oE '"[a-z][a-z0-9_]+"\s*(to|:)' || true)
```

Apply three rules:

1. **Feature without analytics.** If `FEATURE_DIFF` is non-empty but
   `ANALYTICS_FILES` is empty, decide deliberately: does this feature/flow have a
   funnel step or key action worth measuring (a CTA, a success, a failure, a
   screen reached)? If yes and it's uninstrumented, flag it **Important** and ask
   the user — most user-facing flows should emit at least an entry + outcome event.
   A pure refactor / bug fix / copy tweak legitimately needs none; say so.

2. **Cross-platform analytics drift.** If `ANALYTICS_FILES` touches more than one
   platform (or the feature ships on multiple platforms), the **event names +
   param keys must be byte-identical** across iOS / Android / web. Diff the three
   `AnalyticsService` files against each other for the changed events; any mismatch
   in event name or param key is a **Critical** finding (it silently splits the
   shared dashboards). Android's `AnalyticsServiceTest.kt` should also assert the
   new mappings.

3. **⚠️ New event parameter → GA4 custom dimension reminder (LOUD).** If
   `NEW_PARAMS` is non-empty, the diff introduced new event parameter key(s). GA4
   collects them but **cannot filter/break-down by them until each is registered
   as a custom dimension, and registration is NOT retroactive.** You cannot do this
   for the user (it's in their Google Analytics account). So:
   - **Surface an unmissable reminder to the user**, listing each new param key and
     the exact path: *GA4 → Admin → Data display → Custom definitions → Custom
     dimensions → Create custom dimension → Scope = Event, Event parameter = `<key>`.*
   - **Record the pending dimensions in this PR's `## Notes`** ("GA4 dimensions to
     register before relying on breakdowns: `<key>`, …") so it's not lost at merge.
   - This is advisory, not a merge blocker — but it MUST be said out loud, every time.

If none of the three apply, state it briefly ("Analytics: no user-facing flow /
no new events or params") and continue.

## Step 3.12 — User-visible copy: no em/en dashes (before review)

The em-dash (`—`, U+2014) and en-dash (`–`, U+2013) read as an AI-generation "tell"
and are **banned from all user-visible product copy** (the standing rule lives in
the project's `CLAUDE.md` → "User-Visible Copy Style"). They sneak in constantly
because models love them. Catch them on the diff before review.

```bash
# Added lines in this diff that introduce an em-dash (—) or en-dash (–).
git diff origin/main..HEAD | /usr/bin/grep -nE '^\+' | /usr/bin/grep -E '—|–' || true
```

For each hit, decide whether it lands in **text a real end user sees** — UI strings
(`Text(...)`, Compose strings, JSX), `strings.xml`, marketing/onboarding/landing
copy, page `<title>`/meta, error/alert/toast/paywall/placeholder copy, and
**Firestore-seeded copy users read** (quick-fix `description`s, scene/style `name`s,
app-gate/feedback copy):

- **User-visible → must fix before merge.** Replace with natural punctuation (period
  to split sentences, comma, colon for an intro/list, parentheses for an aside;
  hyphen for numeric ranges like `1-3`). Do **not** just swap `—` for `-`. Keep the
  copy identical across web / iOS / Android. If the string is a Firestore-seeded
  value, fix the source seed file **and** re-sync the live collection (the served
  copy comes from Firestore, not the bundled fallback).
- **Not user-visible → leave as-is.** Code comments, `*.md` docs, `console`/`logError`/
  analytics/log strings, AI system/generation/enhancer prompts (sent to the model,
  never shown to users), and a lone `—` used deliberately as an empty-value
  placeholder glyph (e.g. a blank profile field).

If there are no user-visible hits, state it briefly ("Copy: no em/en dashes in
user-visible text") and continue.

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

# Backward-compat surfaces — server contract, Firestore schema/rules/indexes,
# iOS DTOs, IAP product / credit / webhook shape. The app is live in production;
# a renamed field or removed route silently strands installed iOS clients.
# Mirrors Step 3.5's classification — this auto-escalator guarantees the
# Backward compatibility agent runs even if Step 3.5 was skipped or misjudged.
BACKCOMPAT_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^src/app/api/.*route\.ts$|^src/lib/services/|^src/lib/ai/providers/|^src/types/|^(firestore|storage)\.(rules|indexes\.json)$|^ios/[^/]+/Models/|^android/.*/data/models/|iap-products|credit-service|apple-notifications|webhook|refund' || true)
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
| `BACKCOMPAT_DIFF` non-empty | Production is live with older iOS binaries in the App Store. A contract / schema / DTO change shipped silently strands installed clients on a contract that no longer exists, and corrupts persisted docs. AGENTS.md "🚨 EXTREMELY IMPORTANT — production is live, no breaking changes" forbids the silent path. |

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
| **Anti-patterns** | Does the diff use a forbidden primitive where this repo mandates an established abstraction, or put vendor/provider-specific branching in the wrong layer? The authoritative list lives in `CLAUDE.md` + `AGENTS.md` (+ the saas-template `template/AGENTS.md`) — **read them, they evolve**; the concrete checks below are the high-value catches as of writing, not the whole list. (1) **Vendor/provider branching in the wrong layer** — `if (provider === "x")` / `if (model === "astria")` / `if generationModel == ...` style branches in UI, route handlers, or client (iOS/web) code; this belongs in the AI provider factory (`src/lib/ai/providers/`), never the caller (Pluggable Provider + Thin Client). This is the exact class that slips past every other agent — a conditional keyed on a vendor/provider/model name *outside the factory* is the tell. (2) **Backward-compat shims** — `if (oldFormat)` branches, renamed-unused `_vars`, types re-exported only to preserve a removed symbol, `// removed`-style tombstone comments. (3) **Design tokens** — hardcoded Tailwind color classes (`bg-gray-900`, `text-blue-400`) instead of the semantic tokens in `globals.css`. (4) **iOS haptics** — instantiating `UIImpactFeedbackGenerator` / `UINotificationFeedbackGenerator` / `UISelectionFeedbackGenerator` directly instead of the `Haptics` helper. (5) **iOS modals** — `.sheet` / `.fullScreenCover` / `.popover` directly instead of `.adaptiveModal`. (6) **Web confirmations** — `window.confirm()` / `alert()` instead of `ConfirmDialog` + `useConfirm`. (7) **Web on/off & selection** — raw `<input type="checkbox">` instead of the `Toggle` component. (8) **Duplicated AI logic** — copy-pasted quality-check / prompt-enhance / generate code instead of the shared `src/lib/ai/` modules. (9) **Manual Xcode project edits** — hand-edited `project.pbxproj`, a target `Info.plist`, or an `.xcscheme` instead of lifting the setting into `project.yml` (silently wiped on the next `xcodegen generate`). (10) **Reinventing a packaged capability** — building in-app what an SPM/NPM in the Module-dependencies table already provides. Distinct from *Separation of concerns* ("is logic in the right kind of place?") and *Root cause* ("is this a hack hiding a bug?") — this agent asks "did you bypass an abstraction the project explicitly mandates?" |
| **Separation of concerns** | Business logic leaking into UI/routes, God objects, mixed responsibilities, code structured in a way that makes it untestable (hidden dependencies, untyped boundaries, side effects in constructors) |
| **Simplicity** | Over-engineering, premature abstraction, code that could be half the size |
| **Tests** | Missing tests entirely for new logic (not just coverage gaps); branches/edge cases not exercised; tests that pass even if the logic breaks; rules tests missing when `firestore.rules` / `storage.rules` changed |
| **Root cause** | Hacks vs. real fixes — band-aids that mask the underlying bug, `try/catch` that swallows errors silently, special-cases for one weird input instead of fixing the type/contract, commented-out code left behind, `// HACK` / `// FIXME` comments, magic constants that should be config, "works for now" shims. Each finding must name the symptom AND the root cause that's being papered over. |
| **Bug hunter** | Concrete logic bugs that would fire at runtime: off-by-one, wrong variable used, null/undefined/optional access without check, async/await mistakes (missing `await`, fire-and-forget promises), wrong comparison operator, conditions that can't both be true, race conditions on shared state, type coercion gotchas. Distinct from "code quality" — this is "does it work?", not "is it pretty?" |
| **Hot-path performance & degradation** | Does this regress *user-perceived* performance on a rendering hot path — the gallery, the editor, app launch, any high-frequency list/grid? (1) Does it add a network round-trip, an N+1 pattern, or blocking work **before first paint** on a screen the user hits constantly? (2) Does a new dependency (an API call, a signed-URL resolution, a Firestore read) now sit on the critical render path where the old code rendered synchronously? (3) **Graceful degradation** — when that dependency is slow, times out, or fails, what does the user see: a spinner that resolves, or a permanently-blank cell? (4) Is there a before/after first-paint cost, and is it stated in the PR description? Every other agent assumes the change is conceptually sound and reviews within that frame — this agent is the one that asks *what it costs the user*. A clean, secure, well-tested implementation of a hot-path-hostile design is still a regression (this agent exists because PR #402 — signed-URL media — passed every other gate and still serialized gallery load behind a per-cell round-trip). |
| **Data design** *(only if `SCHEMA_DIFF` non-empty)* | (1) Firestore conventions: collection names plural+camelCase, fields camelCase, no nested-map abuse where a subcollection fits, timestamps as `Timestamp` not strings, IDs as strings not numbers, no boolean flags that should be enums. (2) Read/write patterns scale: no unbounded subcollections under hot docs, no queries that would force a fanout index, batches/transactions used where consistency matters. (3) **Rules + rules tests** added per CLAUDE.md (field-level whitelists for client-writable docs, server-only collections set `allow read, write: if false`). (4) **Migration/cleanup**: if fields were renamed or removed, is there a backfill or cleanup script? Are old docs left as garbage? (5) Indexes declared in `firestore.indexes.json` for new composite queries. |
| **Analytics / tracking** | New user-facing action shipped without an analytics event (web: `Analytics.*` from `src/lib/firebase/analytics.ts`; iOS: `Analytics.logEvent` via `ios/.../Services/AnalyticsService.swift`). Existing event names/params changed in a way that breaks dashboards/funnels. PII (email, prompts, user IDs beyond what we already log) accidentally being sent as event params. Same event firing twice on the same action (silent metric inflation). Event names inconsistent with existing convention (snake_case in iOS calls, see `photo_generated` / `edit_applied` / `model_training_started`). |
| **Credits / billing** | Any new code path that calls AI generation, video generation, model training, or any other paid action — does it go through `useCredit` / `hasCredits` from `src/lib/services/credit-service.ts` (or `getVideoCreditCost` for video)? Server route handlers must check credits *before* the paid call; refund (`addCredits`) on failure to avoid silent revenue leak. Conversely: code that grants credits (`addCredits`, `addCreditsInTransaction`) outside of the IAP/webhook/admin flows is a giveaway bug. Changes to the IAP receipt / webhook handlers, App Store Connect notifications, or refund paths warrant **Critical** scrutiny — these touch money directly. If the diff *should not* affect credits (e.g. a pure UI refactor) and yet touches any credit-service call site, flag it. |
| **Backward compatibility** *(only if `BACKCOMPAT_DIFF` non-empty)* | The app is live in production with older iOS builds in the App Store (and, once shipped, older Android builds on Play) that cannot be force-updated. (1) Does any hunk rename, remove, or retype a field on an existing Firestore doc, HTTP API request/response, iOS DTO, Android DTO, IAP product, or webhook payload? (2) Does it remove/rename a route the live iOS app calls or an analytics event it emits? (3) Does it tighten existing validation in a way that rejects payloads the old iOS client still sends? (4) Did the author claim "additive" but actually change the *type* of an existing field, add a *required* field without a default, or promote an optional field to required? (5) Is there evidence the change was made backwards-compatibly on purpose — PR description explicitly says so, dual-write/dual-read pattern present, default values supplied, version-gated branches carry a stated kill date — or did it slip through silently? **Don't reward a `if (oldFormat) ... else ...` shim as a fix** — flag it as debt; the right answer is usually a real migration with a kill date or a deferral until the next forced-update release. Any breaking change found that *isn't* explicitly documented as accepted in the PR description = **Critical** — do not merge; renegotiate with the user per AGENTS.md "🚨 EXTREMELY IMPORTANT — production is live, no breaking changes". |

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
- *Anti-patterns:* a hand edit to `project.pbxproj` / a target `Info.plist` / an `.xcscheme` (silently wiped on the next `xcodegen generate` → lost work) = **Critical**. Vendor/provider/model branching that leaks into the server contract the thin client depends on (could strand older iOS clients that can't be force-updated) = **Critical**; the same branching contained to web/server-only code = **Important**. Using a forbidden primitive where the project mandates an abstraction (raw `.sheet`, `window.confirm`, raw checkbox, hardcoded color class, direct haptic generator, duplicated AI logic, a reinvented packaged capability) = **Important** — it works, but it violates a hard project rule and drifts the codebase; fix before merge. A general/stylistic anti-pattern with no codified project rule = **Minor**.
- *Hot-path performance & degradation:* a new blocking round-trip / N+1 / per-item network dependency **before first paint** on a hot path = **Critical** — do not merge; the *design* needs to change, not the code. A new render-path dependency with no graceful-degradation story (blank-forever on failure) = **Critical**. A bounded latency add on a non-hot path, or a hot-path add that is already async / cached / non-blocking with a real fallback = **Minor**. "Looks good" here means the change either doesn't touch a hot path or keeps the render path synchronous/cached.
- *Backward compatibility:* any rename / remove / retype of a live contract field, route, analytics event, IAP product, or persisted Firestore field = **Critical** — production breakage on installed iOS clients. Tightened validation that rejects payloads the old iOS client still sends = **Critical**. A permanent `if (oldFormat) ... else ...` shim added in place of a real migration plan = **Important** (debt-on-debt; ask whether a migration with a kill date is on the table). Additive-only change explicitly documented as backwards-compatible in the PR's `## Notes` = "Looks good". Additive change with no `## Notes` line at all = **Minor** (ask the author to add the one-liner so a future reviewer doesn't have to re-derive it).

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

# Android UI changes — Compose screens/components/theme, the activity/root, and resources.
# Mirrors IOS_UI_DIFF. Single-line regex (BSD grep aborts on embedded newlines).
ANDROID_UI_DIFF=$(echo "$DIFF_FILES" | /usr/bin/grep -E '^android/.*/(ui|components|theme)/.*\.kt$|^android/.*/(MainActivity|RootScreen|.*Screen|.*Activity)\.kt$|^android/app/src/main/res/' || true)

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

### Android surface (`ANDROID_UI_DIFF` non-empty)

1. Prompt: *"Android UI changed. Build + run on the emulator (`/simulator android`) and drive the affected flow before merge? Or 'skip'."*
   - **picks** → invoke `/simulator android` to build, install, and launch on the emulator, then drive the changed flow. Take a screenshot of any visual change. **Pause merge on any ❌** (crash, broken render, logcat error).
   - **skip** → note the skip in the merge comment.
2. There is no Android `/qa` (computer-use-driven) equivalent yet — verification is manual via the emulator. If the change has an iOS counterpart with a `## Visual smoke test`, the same steps apply conceptually; check parity by eye.

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
- Diff is Android-only (`android/...`) — the Gradle build (Step 5.9b) catches Kotlin type errors; `next build` is irrelevant.
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

## Step 5.8b — Unit test gate: `npm test` (REQUIRED for any web change)

**Why this step exists:** `next build` (5.8) catches *type* mismatches but runs no assertions — it won't tell you the credit math is wrong, the webhook idempotency check regressed, or a rules change opened a hole. The vitest suite does. Until now `/doit` had no step that actually *ran* the unit suite — it only reported a count in Step 7 and leaned on the git **pre-push hook** (`npm run test:all`) as the de-facto gate. That's fragile: the hook is bypassable (`--no-verify`), and a worktree dep mismatch (see the Step 3 pre-flight) makes it fail for reasons that *look* like pre-existing breakage and invite a bypass. Make the gate explicit and owned by the skill.

### When to skip Step 5.8b

- Diff is documentation / asset / copy-only — no logic to exercise.
- Diff is iOS-only (`ios/...`) — the iOS build (5.9) + XCUITest (5.6) are the verification; there's no vitest for Swift.
- Diff is Android-only (`android/...`) — the Android build (5.9b) + Android unit tests (5.9c) are the verification; there's no vitest for Kotlin.
- Diff is skill / config files with no associated TS.

In any other case (`src/**`, `scripts/*.ts`, `firestore.rules`, anything with test coverage), **run it**.

### Run

```bash
# Web unit suite. If firestore.rules / storage.rules (or their tests) changed, run the
# rules suite too — `npm run test:all` does both (unit + emulator-backed rules tests).
npm test 2>&1 | tail -15
# …or, when rules changed:
npm run test:all 2>&1 | tail -15
```

Expected: `Test Files  N passed` / `Tests  N passed`, exit code 0 — **zero failed**. (The rules suite logs expected `PERMISSION_DENIED` lines from its negative tests; those are not failures — read the final summary, not the stderr.)

This is also where the **Step 3 worktree pre-flight pays off** — if `npm test` face-plants with `Cannot find package '@aryaxt/...'` or `X is not a function` across many unrelated suites, that's the stale-`node_modules` signature, not a real failure: run `npm install` in the worktree (Step 3 pre-flight) and re-run, don't start "fixing" green tests.

### On failure

A genuinely failing test is a **Critical** finding equivalent — do not merge.

1. **Stop the merge.**
2. Triage: is it (a) a real regression this change introduced, (b) a brittle/now-outdated test whose expectation legitimately changed, or (c) the stale-deps artifact above?
   - (a) → fix the code at its source, push to the same PR branch.
   - (b) → update the test to assert the new contract (don't delete it to get green).
   - (c) → `npm install` in the worktree; re-run. Not a code change.
3. Re-run `npm test` until green, then continue.

### Don't bypass

- Don't merge with a failing suite "to fix later" — it rots, and the next change inherits a red baseline that hides its own regressions.
- Don't `git push --no-verify` to skip the pre-push hook *as a way around a red suite*. Bypass is only ever acceptable once you've **diagnosed** the failures as pre-existing and unrelated to the diff (e.g. the worktree dep artifact) — and even then, fixing the environment (the Step 3 `npm install`) is the right move, not the bypass.

## Step 5.9 — Build gate: `xcodebuild` (REQUIRED for any iOS Swift change)

Parallel to Step 5.8's `next build` for the web, this is the iOS equivalent. Catches compile errors that vitest-style unit tests can't see — Swift type errors, missing imports, **duplicate declarations** (you'd be surprised), `@MainActor` boundary violations.

**Why this step exists:** we shipped PR #371 with a duplicate `private func runQuickFix` in `ImageDetailView.swift` — squash-merge artifact from a PR-branch that forked from the same worktree the iOS PR shipped from. The duplicate sat on `main` for 30+ minutes before anyone noticed because we kept building from the *worktree* (which had a single copy) instead of from main. A clean build catches this class in seconds.

### When to skip Step 5.9

- Diff is web-only (`src/**`, `firestore.rules`, `scripts/**`) — no Swift touched.
- Diff is documentation, assets, plists, or `project.yml` changes that don't affect compilation.
- Diff is pure asset-catalog changes (new `*.imageset`, `*.colorset`) — Xcode resolves these at run time, not at compile.

In any other case (`ios/**/*.swift`, `ios/project.yml` with new source paths, anything touching the SwiftPM Package.swift, target settings, or build phases), **run it**.

### Pre-flight: fix worktree saas-template symlink (if applicable)

`/doit` typically creates a feature branch under `.claude/worktrees/`, so the `../../saas-template/...` SPM paths in `ios/project.yml` don't resolve. Symlink the peer location first (same pattern `/chrome` uses for `.env.local`):

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

## Step 5.9b — Build gate: `gradlew assembleDebug` (REQUIRED for any Android Kotlin change)

Parallel to Step 5.9's `xcodebuild` for iOS, this is the Android equivalent. Catches Kotlin compile errors, missing imports, unresolved references, and `@Serializable`/Compose annotation-processor failures that unit tests can't see.

### When to skip Step 5.9b

- Diff touches no Android files (`android/**` empty in the diff).
- Diff is Android documentation, assets (`res/` drawables/strings only), or Gradle changes that don't affect compilation.
- The `android/` project doesn't exist yet (Foundation layer hasn't landed) — nothing to build.

In any other case (`android/**/*.kt`, `android/**/build.gradle.kts`, `settings.gradle.kts`, `gradle/libs.versions.toml`), **run it**.

### Run

```bash
source scripts/android-config.sh 2>/dev/null || true
test -d android || { echo "android/ not scaffolded — skip"; }
cd android && ./gradlew :app:assembleDebug 2>&1 | tail -15 ; cd -
```

Expected: `BUILD SUCCESSFUL`. **Never pipe in a way that hides `BUILD FAILED`** — check the exit status (same rule as the iOS build). The Gradle build cache (`~/.gradle/caches` + `android/.gradle`) makes warm builds 15–40s.

**No worktree saas-template symlink step** — the Android `:app` module consumes no saas-template SPMs (it's self-contained per the parity spec), so the iOS Step 5.9 symlink pre-flight does not apply.

### On failure

Treat as Critical equivalent — same severity as a security bug. Android doesn't auto-deploy (Play is a manual `/playstore` step), so a broken main doesn't immediately ship, but it blocks anyone running `/simulator android` after pulling main and the next Play cut. Read the error, fix the root cause (don't `@Suppress` past it), re-run, commit, push.

## Step 5.9c — Unit test gate: `gradlew testDebugUnitTest` (REQUIRED for any Android Kotlin change)

**Why this step exists:** Step 5.9b's `assembleDebug` *compiles* the Android code (including the test sources, transitively) but runs **no assertions** — it's the Android analog of `next build` (5.8) / `xcodebuild` (5.9), and it won't tell you a DTO `@Serializable` round-trip broke, the credit math in a ViewModel regressed, or a mapper now drops a field. The JVM unit suite does. This is the Android counterpart of Step 5.8b's `npm test` (web vitest) and Step 5.6's XCUITest run (iOS) — the platforms each have a build gate AND a test gate, and Android was missing the second. The suite is substantial (`android/app/src/test/` carries real ViewModel / mapper / DTO coverage), so a green compile is not a green suite.

`:app:testDebugUnitTest` runs **JVM-local unit tests only** — no emulator, no device, fast. It does NOT run `androidTest` instrumented tests (those need an emulator and belong to the manual `/simulator android` smoke test in Step 5.5, not an automated gate).

### When to skip Step 5.9c

- Diff touches no Android files (`android/**` empty in the diff).
- Diff is Android documentation, assets (`res/` drawables/strings only), or Gradle changes that don't affect compiled logic.
- The `android/` project doesn't exist yet (Foundation layer hasn't landed), or it carries no `app/src/test/` sources — nothing to run.

In any other case (`android/**/*.kt`, `android/**/build.gradle.kts`, `settings.gradle.kts`, `gradle/libs.versions.toml`), **run it**.

### Run

```bash
source scripts/android-config.sh 2>/dev/null || true
test -d android/app/src/test || { echo "no android/app/src/test — skip"; }
cd android && ./gradlew :app:testDebugUnitTest 2>&1 | tail -20 ; cd -
```

Expected: `BUILD SUCCESSFUL`, exit code 0 — **zero failed**. **Never pipe in a way that hides `BUILD FAILED`** — check the exit status (same rule as the build gates). On failure, the per-test HTML report lands at `android/app/build/reports/tests/testDebugUnitTest/index.html`; read it for the failing assertion. Gradle caches make a warm test run 15–40s; it's incremental, so an `assembleDebug` (5.9b) immediately before warms most of the compile.

### On failure

A genuinely failing test is a **Critical** finding equivalent — do not merge.

1. **Stop the merge.**
2. Triage: is it (a) a real regression this change introduced, or (b) a test whose expectation legitimately changed because the contract changed on purpose?
   - (a) → fix the code at its source, push to the same PR branch.
   - (b) → update the test to assert the new contract (don't delete it to get green).
3. Re-run `:app:testDebugUnitTest` until green, then continue.

Same no-deploy caveat as 5.9b — a red suite on main doesn't immediately ship, but it rots and hides the next regression. Don't merge "to fix later," and don't `@Ignore` a failing test as a shortcut to green.

## Step 6 — Merge

Once all Critical and Important issues are resolved:

```bash
gh pr merge <PR-number> --squash --delete-branch
git checkout main
git pull --ff-only origin main
```

If multiple PRs exist, merge them in dependency order. If they're independent, merge whichever is reviewed-and-clean first.

### Hard gate: cross-repo / cross-branch dependencies (from Step 3.10)

**Do NOT merge this PR while any dependency PR identified in Step 3.10 is still open.** Merging a consumer ahead of the dependency it needs is exactly how `main` breaks (`export X was not found`, a route/skill/field that doesn't exist, a stuck deploy, stranded installed clients).

For each dependency PR, in order:

1. **Ship the dependency first — from its worktree, then restore the sibling to `main`.** The sibling change lives in the `${SIB}-wt` worktree from Step 3.10 (if it's still uncommitted in the primary checkout, you skipped the worktree step — move it into one now). Commit, PR, review, merge with `--delete-branch`, then tear the worktree down so the sibling returns to a pure `main`:

   ```bash
   SIB=~/Desktop/Repos/<sibling>; WT="${SIB}-wt"
   git -C "$WT" add -A && git -C "$WT" commit -m "<what changed>"
   git -C "$WT" push -u origin <branch>
   gh -R aryaxt/<sibling> pr create --fill                   # review it to the SAME bar as the app PR
   gh -R aryaxt/<sibling> pr merge <n> --squash --delete-branch
   # Restore the sibling to fresh main and remove the worktree (this is "switch the template PR back to main"):
   git -C "$SIB" checkout main && git -C "$SIB" pull --ff-only
   git -C "$SIB" worktree remove "$WT"                       # --force only if it has leftover build artifacts
   git -C "$SIB" branch -D <branch> 2>/dev/null || true      # the branch ref, if it lingers post-worktree
   ```

   For a saas-template **NPM** package edit, update that package's `CLAUDE.md` in the *same* sibling PR. The sibling PR gets the same review bar as the app PR — don't rubber-stamp it just because it's "only a package."
2. **Pull the *merged* dependency into this change's base** — for iOS, restore the peer symlink to the primary clone now on merged `main` (`ln -sfn "$SIB" "$(dirname "$(git rev-parse --show-toplevel)")/saas-template"`); for NPM run `npm run vendor:refresh` (default source = the clone, now on merged main) and commit the `vendor/` + `package-lock.json` diff into the app PR; **for `aryaxt-skills` plugin skills, run the cache-refresh procedure below** (NOT a bare `/plugin update` — a skill can't invoke that built-in command itself, which is exactly how the cache went stale and a merged skill change silently failed to take effect). Whatever brings the merged dependency, not the open-PR/worktree version, into this PR's world.
3. **Re-run the build gate** (Step 5.8 `next build` / 5.9 `xcodebuild` / 5.9b `gradlew`) so this PR is verified against the *merged* dependency.
4. Only then merge this PR.

### Refresh the local plugin cache after ANY `aryaxt-skills` merge (REQUIRED)

Whenever a PR is merged into `aryaxt-skills` during a `/doit` run — whether it's the primary work or a sibling dependency of an app PR — the locally-installed plugin must be reset to the just-merged `main`, or the merged skill change won't take effect in this (or the next) session. This is the failure that shipped a `/playstore` run blind to its own uploader scripts: the scripts were on `aryaxt-skills` `main`, but the local plugin **cache** predated them, so the skill behaved as if they didn't exist.

A skill cannot invoke the built-in `/plugin update` command itself, so do the git-level equivalent — pull the marketplace clone to merged `main`, then re-copy it into every cached version dir:

```bash
MP=~/.claude/plugins/marketplaces/aryaxt          # the marketplace = a git clone of aryaxt-skills
# The clone is a generated mirror, never hand-edited — if it's somehow dirty,
# `git -C "$MP" reset --hard` first, else the checkout below aborts the whole refresh.
git -C "$MP" checkout -q main && git -C "$MP" pull --ff-only origin main
# Re-sync each cached plugin version from the freshly-pulled clone (copy-only; never rename the version dir):
for vdir in ~/.claude/plugins/cache/aryaxt/aryaxt-skills/*/; do
  rsync -a --delete "$MP/skills/" "$vdir/skills/"
  [ -d "$MP/.claude-plugin" ] && rsync -a "$MP/.claude-plugin/" "$vdir/.claude-plugin/" 2>/dev/null || true
done
# Sanity-check: the file you just merged should now exist under the cache.
ls ~/.claude/plugins/cache/aryaxt/aryaxt-skills/*/skills/<changed-skill>/
```

Notes:
- This is safe and reversible — it only copies files into the existing cache version dir; it does not delete or rename the dir, so a half-run can't brick the plugin.
- If `installed_plugins.json` shows a plugin **version bump** (the `.claude-plugin` manifest's `version` changed), the cache dir name (e.g. `0.1.0/`) will differ from the new manifest version; in that case also tell the user to run `/plugin update aryaxt-skills` so Claude Code creates the new version dir — the rsync above keeps the *current* session working regardless.
- Mention in the final report that the plugin cache was refreshed to `<merged-sha>`, so the user knows the new skill behavior is live.

**Always `--delete-branch` on the sibling merge AND `worktree remove` the sibling worktree** — confirm the remote branch, the local branch, and the worktree are all gone, and the primary checkout is back on clean `main`. The out-of-sync pile of dead branches and orphaned worktrees in `saas-template` is exactly the drift this gate exists to stop. If you cut a sibling branch/worktree that ends up NOT shipping (abandoned, or folded into another PR), remove it too — don't leave it dangling.

If a dependency **can't** land yet (blocked, needs more review, not ready), **defer this PR** — don't merge it half-wired. Say so explicitly in the PR and to the user; a deferred PR with a clear "blocked on <dep PR>" note is correct, a merged-and-broken `main` is not.

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

### Post-merge Android verification (REQUIRED when Android files were merged)

Same squash-merge risk as iOS (a declaration landing twice from an earlier merge). Once main is updated, if the merged PR touched `android/**/*.kt`:

```bash
git checkout main && git pull --ff-only origin main
cd android && ./gradlew :app:assembleDebug 2>&1 | tail -10 ; cd -
```

Expected: `BUILD SUCCESSFUL`. If it fails, push a hotfix commit to `main` immediately — Android doesn't auto-deploy (web stays safe), but a broken main blocks everyone's pull-rebase-build and the next `/playstore` cut. Skip when the merged PR touched zero Android files, or `android/` doesn't exist yet.

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
| Android build (Step 5.9b) | <SUCCEEDED / FAILED / N/A> |
| Android unit tests (Step 5.9c) | <N passing / N failing / skipped — why> |
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

**Sibling-repo hygiene (REQUIRED).** The session often touches `saas-template` / `aryaxt-skills`, and left unattended those repos accumulate dead branches, orphaned worktrees, and stray uncommitted edits that drift out of sync (this is how `saas-template` reached 39 stale branches + 2 leftover merged worktrees). The end state to confirm: **each sibling's primary checkout on a clean, current `main`, no `/doit`-created worktree left behind.** Re-run the detection across the siblings and report:

```bash
REPOS_DIR=$(dirname "$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd -P)")")
for sib in saas-template aryaxt-skills; do
  SIB="$REPOS_DIR/$sib"; git -C "$SIB" rev-parse --git-dir >/dev/null 2>&1 || continue
  git -C "$SIB" fetch -q origin --prune 2>/dev/null || true
  echo "=== $sib (primary checkout on: $(git -C "$SIB" rev-parse --abbrev-ref HEAD)) ==="
  echo "  uncommitted (excl. build noise):"
  git -C "$SIB" status --porcelain | /usr/bin/grep -vE '\.build/|node_modules/|^\?\? android/' | sed 's/^/    /'
  echo "  worktrees (anything besides the primary clone on main is suspect):"
  git -C "$SIB" worktree list | sed 's/^/    /'
  echo "  non-main local branches ($(git -C "$SIB" for-each-ref --format='%(refname:short)' refs/heads/ | /usr/bin/grep -vxc main) total):"
  git -C "$SIB" for-each-ref --format='%(refname:short)' refs/heads/ | /usr/bin/grep -vx main | sed 's/^/    /'
done
```

- **Primary checkout not on `main`** → restore it (`git -C <sib> checkout main && git -C <sib> pull --ff-only`). This is the "switch the template back to main" the user asked for; the in-flight branch survives as a ref / open PR.
- **Leftover worktree for an already-merged branch** → `git -C <sib> worktree remove --force <path>` then `git -C <sib> worktree prune`. A worktree holds its branch, blocking branch deletion — remove it first.
- **Uncommitted edits in a sibling that came from THIS session** → same keep/discard triage as the app tree. If they were part of the change just shipped, they should already be a merged PR from Step 6 — flag loudly if still sitting uncommitted. (Stat-dirty-but-`git diff`-empty files are a harmless branch-switch artifact — clear with `git -C <sib> checkout -- <path>`.)
- **Stale local branches** → the reliable "safe to delete" test is **a merged PR**, not `git branch --merged`: squash-merge (this project's default) leaves the branch tip unreachable from `main`, so `--merged` reports it as un-merged and misses it. Cross-reference instead:
  ```bash
  gh -R aryaxt/<sib> pr list --state merged --limit 200 --json headRefName -q '.[].headRefName' | sort -u > /tmp/merged.txt
  git -C <sib> for-each-ref --format='%(refname:short)' refs/heads/ | grep -vx main | sort -u > /tmp/local.txt
  comm -12 /tmp/local.txt /tmp/merged.txt    # branches with a merged PR → delete with `git -C <sib> branch -D`
  ```
  Delete the merged-PR branches (`-D`, since `-d` refuses squash-merged ones). Do NOT delete branches with an **open** PR or **no** PR (live WIP) — list those so the user decides. Report the before/after non-main branch count.

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
