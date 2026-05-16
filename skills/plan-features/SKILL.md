---
name: plan-features
description: Translate a validated product idea into a per-task implementation plan, prioritized as mvp / v1 / v2. Each task is detailed enough to implement in a single agent prompt without hand-holding. Run AFTER /aryaxt:research-idea returns a GO. Use when the user says "plan features", "create implementation plan", "break X into tasks", or similar. Replaces the deprecated saas-template MCP plan_features tool.
---

# Plan Features — Per-task implementation plan for a validated idea

## When to use this

Run AFTER `/aryaxt:research-idea` returned a GO (or conditional GO with resolved gaps). The user gives you:

1. A project path (where the saas-template-scaffolded code lives)
2. A product name + 2–3 sentence description
3. A list of features with priorities (mvp / v1 / v2)

You produce a `docs/implementation-plan.md` that an agent (or human) can execute one task at a time without re-research.

## Hard prerequisite — DO NOT skip

Before this skill: market research must be done and decision must be GO. If the user jumps to "let's plan features" without prior validation, stop and run `/aryaxt:research-idea` first. Building the wrong thing is the most expensive mistake.

## Step 1 — Read the existing project

```bash
cd <PROJECT_PATH>

# Verify it's a saas-template-derived project
[ -f .saas-template.json ] || { echo "Not a saas-template project — run /aryaxt:create-project first"; exit 1; }

# Inventory existing code so the plan doesn't duplicate it
find src -type f | head -60       # show file structure
cat package.json | grep -E '"@aryaxt|firebase|next"'  # confirm wired deps
cat src/types/index.ts 2>/dev/null | head -60  # existing types
```

## Step 2 — Surface what's already built (DO NOT REBUILD)

Every saas-template-derived project ships with this infrastructure. **Never rebuild any of it** in the implementation plan:

| Infrastructure | Where it lives | How to use it |
|---|---|---|
| Firebase Auth (Google sign-in, session mgmt, roles) | `@aryaxt/auth` + `src/hooks/use-auth` | Don't reimplement auth UI/flow |
| Firestore admin SDK | `firebase-admin` via `src/lib/firebase/server.ts` | Use this for server-side reads/writes |
| Credits system | `src/lib/services/credit-service.ts` | Use `useCredit` / `hasCredits` for paid actions |
| Admin panel | `@aryaxt/admin-shell` wired in `src/app/(main)/admin/page.tsx` | Add tabs by appending to the `tabs[]` array |
| Landing page | `src/components/landing/*` | Customize TEXT ONLY (no className changes) |
| Design system | `src/app/globals.css` `@theme inline` block | Use semantic tokens (`bg-surface`, `text-heading`, etc.) — NEVER hardcoded colors |
| Error logging | `@aryaxt/error-reporting` + `src/lib/services/error-log-service.ts` | Use `logError()` in catch blocks |
| Apple IAP | `@aryaxt/iap` server + `@aryaxt/iap-admin` admin tab | Webhook routes already wired |
| Push notifications | `@aryaxt/push-notifications` | Device register handler already wired |
| Paywall / settings / onboarding / navbar / confirm dialogs | various `src/components` | Reuse |

If the user's feature touches one of these areas, the plan task is "add X to the existing system" not "build X."

## Step 3 — Separate features by priority

Build three lists from the user's input:

- **MVP** — must be in launch. Detailed per-task plans (see step 4).
- **V1** — soon after launch. One-paragraph descriptions only.
- **V2** — based on user feedback. One-line descriptions.

If the user gave you 10+ features all marked "mvp", push back: an MVP that takes 6 months to build is not an MVP. Help them re-prioritize. Aim for ≤ 5 mvp features at most.

## Step 4 — Per-MVP-task deliverables (this is what the agent will implement)

For each mvp feature, the plan task contains:

1. **Firestore data model**
   - Collection name(s), document shape, fields, types
   - Indexes needed (for any composite query)
   - **Rules entries** under `firestore.rules` — field-level whitelists for client-writable docs, `allow read, write: if false` for server-only collections
   - **Rules tests** under `src/__tests__/rules/firestore.test.ts` — anonymous denied, owner allowed, cross-user denied, each forbidden field rejected

2. **TypeScript types**
   - Added to `src/types/index.ts`
   - Field-by-field, including optionality and defaults
   - Discriminated unions where state varies

3. **Service file**
   - Path: `src/lib/services/<feature>-service.ts`
   - CRUD functions named after the operation (`createX`, `getXById`, `listXForUser`, `updateX`, `deleteX`)
   - Uses `adminDb` from `src/lib/firebase/server.ts`
   - Wraps logic in try/catch + `logError("<service-name>:<op>", err)`

4. **API route(s)**
   - Path: `src/app/api/<feature>/route.ts`
   - Method + auth check (`verifyAuthHeader` from `@aryaxt/auth`)
   - App Check enforcement (`requireAppCheck` from `@aryaxt/app-check`) — register in `src/__tests__/security/app-check-routes-manifest.ts`
   - Admin-only routes — `isAdmin` check + register in `src/__tests__/security/admin-routes-manifest.ts`
   - Caching strategy decision (per `template/AGENTS.md` "API caching strategy check")
   - Request validation (zod schema or explicit checks; never trust client-side types)
   - Credit deduction call BEFORE the paid action, refund (`addCredits`) on failure

5. **UI component(s)**
   - Path: `src/components/<feature>/`
   - Server components by default; `"use client"` only when needed
   - Design system tokens ONLY (no hardcoded colors)
   - `ConfirmDialog` + `useConfirm()` for destructive actions
   - Mini spinner pattern for loading states (`<span className="w-3.5 h-3.5 border-[1.5px] border-faint border-t-body rounded-full animate-spin" />`)
   - Toggle: `<Toggle>` from `src/components/ui/toggle.tsx`, never raw `<input type="checkbox">`

6. **Page integration**
   - Path: `src/app/(main)/<feature>/page.tsx`
   - Wires service + components into a route

7. **Admin section (if applicable)**
   - Add tab to admin page's `tabs[]` array in `src/app/(main)/admin/page.tsx`
   - Section component at `src/app/(main)/admin/<feature>-section.tsx`

8. **Landing page section update (if user-facing)**
   - Update one of the existing landing components (`hero.tsx`, `how-it-works.tsx`, etc.) to mention the feature
   - TEXT ONLY — no className changes

9. **Analytics events (if user-facing action)**
   - Web: `Analytics.<event>(...)` from `src/lib/firebase/analytics.ts`
   - iOS: `Analytics.logEvent(...)` via `ios/.../Services/AnalyticsService.swift`
   - Event names snake_case, consistent with existing (`photo_generated`, `edit_applied`)

10. **Tests**
    - Vitest unit tests for the service file + API route
    - Rules tests for any new collection/field (per template/CLAUDE.md "Firestore Schema & Security Rules (REQUIRED)")

11. **Documentation**
    - If the feature has operational state (queues, kill switches, secrets, runbook): add `docs/features/<feature>.md`
    - Add the file to the "Currently documented features" list in `CLAUDE.md`

## Step 5 — Cross-cutting rules every task must honor

These apply to every implementation, not per-task:

- **`@/*` import alias** for all imports from src
- **Design system tokens** — `bg-surface`, `text-heading`, `bg-accent`, etc. NEVER `bg-gray-900` / `text-blue-400`
- **Server components by default** — `"use client"` only when needed
- **Named exports** (except pages)
- **All API keys server-side only** — never expose in NEXT_PUBLIC_ env vars
- **Confirm dialogs** for destructive actions (never `window.confirm`)
- **Mini spinner** for loading (never bouncing dots)
- **Log errors** via `logError()` from `@aryaxt/error-reporting`
- **Cross-platform parity** — if it's user-facing and you have iOS + web clients, plan both platforms together (or document the deliberate divergence)
- **Hot-path performance** — if the feature affects gallery / editor / launch / any rendering hot path, state before/after first-paint cost and the graceful-degradation behavior in the plan

## Step 6 — Write the plan document

Path: `<PROJECT_PATH>/docs/implementation-plan.md`

Shape:

```markdown
# <ProductName> — Implementation Plan

**Product:** <one-paragraph description>

**Generated:** <ISO timestamp>

---

## Existing Infrastructure (DO NOT REBUILD)

[copy the "what's already built" list from step 2]

---

## MVP Features (Build First)

### Task 1: <feature name>
**What:** <description>

**Firestore:** <collections + fields + indexes>

**Types added to `src/types/index.ts`:**
```ts
[concrete TS]
```

**Service file `src/lib/services/<feature>-service.ts`:**
- `createX(...)` — ...
- `getXById(id)` — ...

**API route `src/app/api/<feature>/route.ts`:**
- METHOD — auth: <yes/no>, app-check: <yes/no/excluded>, caching: <withEtag/none/no-store + rationale>
- Request: ...
- Response: ...

**UI component `src/components/<feature>/<Name>.tsx`:**
[JSX skeleton showing the structure]

**Page `src/app/(main)/<feature>/page.tsx`:**
[wiring sketch]

**Admin section (if applicable):** ...

**Analytics events:** ...

**Tests:** ...

**Implementation notes:** [anything non-obvious; reference to design system rules; reminder to never duplicate landing copy logic]

### Task 2: ...
...

---

## V1 Features (After Launch)

### <name>
<one-paragraph description>

---

## V2 Features (Based on Feedback)

### <name>
<one-line description>
```

## Step 7 — Present + offer to dispatch

After writing the plan, present a summary in the conversation:

| Priority | Feature count | Estimated agent prompts to implement |
|---|---|---|
| MVP | N | N (each task = 1 agent prompt) |
| V1 | M | M |
| V2 | K | K |

Then offer:
> "Plan saved to `docs/implementation-plan.md`. Want me to dispatch agents to implement Task 1 now? Or review the plan first?"

Default to **review first** — let the user catch over- or under-scoping before agents start writing code.

## Critical rules during planning

- **NEVER rewrite landing page components from scratch.** The template ships fully styled with a dark-theme design system. Customize only TEXT.
- **NEVER use hardcoded Tailwind colors** in the plan's UI sketches. Always semantic tokens.
- **When dispatching subagents** to implement tasks, include this preamble: *"Read existing component files first. Only change text content — do NOT rewrite component structure, styling, or className attributes. The design system uses CSS custom properties + semantic Tailwind tokens that MUST be preserved."*

## What this skill replaces

The deprecated saas-template MCP server's `plan_features` tool. Same content, different delivery vector.

## Related skills

- **Before this:** `/aryaxt:research-idea` (validate before planning)
- **After this:** `/aryaxt:doit` (ship the resulting implementation as PRs)
