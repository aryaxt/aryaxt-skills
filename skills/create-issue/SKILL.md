---
name: create-issue
description: Use when the user wants to capture a new task, bug, or feature as a GitHub issue. Takes a brief plain-text description, researches the codebase for context, and creates a rich, implementation-ready issue on the your GitHub project board in Backlog with appropriate type / surface / priority labels and an optional release-blocker ship-gate.
---

# Create GitHub Issue

Turns a brief description into a well-researched, implementation-ready GitHub issue and places it on the Projects board in **Backlog** with the right labels for type, surface, priority, and (optionally) the `release-blocker` ship-gate.

## Invocation

```
/create-issue add video duration picker 4s/6s/8s
/create-issue fix LoRA face leaking in outfit swap
/create-issue iOS light mode support
```

Everything after the skill name is the description — no quotes needed.

## Steps

### 1. Research the codebase

Explore files relevant to the description. Look for:
- Existing code that would be modified or extended
- Related services, components, and API routes
- Constraints, dependencies, or gotchas
- Prior art (similar features already built)

Use the Explore or Grep agents for broad searches. Spend up to 3–4 searches — enough to write an informed issue, not a full audit.

### 2. Draft the issue body

```markdown
## Summary
One paragraph — what this is and why it matters to the product.

## Context
- Relevant files: `src/...`, `ios/...`
- How it fits the existing architecture
- Dependencies or constraints discovered during research

## Acceptance Criteria
- [ ] Specific, testable condition
- [ ] Edge cases covered
- [ ] Tests written

## Implementation Notes
Suggested approach based on codebase research. Include:
- Which files to modify
- Any gotchas or non-obvious constraints
- Alternative approaches considered and why they were ruled out
```

### 3. Pick labels

Apply **one label from each axis that fits** (type is required; platform is required whenever client code is touched; the rest only if relevant). Three to five labels is typical.

**Type** (required, pick 1):
| Label | When |
|-------|------|
| `feature` | New user-facing capability |
| `bug` | Something is broken or behaves wrong |
| `chore` | Maintenance, deps, cleanup, refactor |
| `enhancement` | Improvement to existing capability (not a new feature) |

**Platform** (REQUIRED — apply EVERY platform the work touches; there can be more than one):
| Label | When |
|-------|------|
| `ios` | iOS app code (`ios/`) |
| `android` | Native Android app code (`android/`) |
| `web` | Web / Next.js client (`src/app/`, `src/components/`) |

ALWAYS tag the platform(s) a ticket affects — never leave a client-facing ticket platform-less. A cross-platform feature (e.g. "add a duration picker" that ships on iOS, Android, and web) gets **all three** of `ios`, `android`, `web`. A bug scoped to one client gets just that one. A purely server-side change with no client work gets **no** platform label (use the Area labels instead) — but if the change is *about* a specific client (e.g. server telemetry mislabeling Android, a route a single client calls), tag that client too. The mobile-first rule still holds: an iOS-lead feature with web/Android follow-ups can be one ticket tagged all three, or split with the follow-ups tagged their platform — but the platform tag must always reflect reality.

**Area** (pick 0–2 — the functional domain, orthogonal to platform):
| Label | When |
|-------|------|
| `ai` | AI provider, prompts, generation, training |
| `backend` | Server-side logic / API routes (not AI, not infra) |
| `infra` | Firebase, App Hosting, CI, deploy, build |
| `auth` | Sign-in, account deletion, sessions, OAuth |
| `payment` | IAP, credits, Stripe, billing |
| `push-notification` | APNs, FCM, Live Activities push |
| `admin` | Admin dashboard, support tools, internal-only |
| `security` | Vulnerability or hardening |

**Severity** is two orthogonal axes, not one:

- **`release-blocker`** is a ship-gate, NOT a priority. It answers "can we cut a release with this open?" Apply it only to issues where the answer is no — data loss, auth or payments broken, app crashes on launch, security holes, anything that would embarrass us or cost real money in production.
- **`P0`/`P1`/`P2`** is a work-priority queue. It answers "what should we work on next?"

The two axes can — and often should — co-occur. A release-blocker is almost always also `P0`. Apply both when both fit; they serve different consumers (ship-gate vs sprint planner).

**Priority** (pick 0–1):
| Label | When |
|-------|------|
| `P0` | Drop everything, work on this next |
| `P1` | Important, work on soon, but other work can land first |
| `P2` | Nice to have, low urgency, can sit in Backlog indefinitely |

**Ship-gate** (pick 0–1, independent of priority):
| Label | When |
|-------|------|
| `release-blocker` | **Must** be fixed before the next production release. Real ship-stoppers only — see definition above. |

**Decision shortcuts:**
- New feature work → no severity label needed; assume `P2` unless told otherwise.
- Polish / paper cuts that users notice but don't break flows → `P1` or `P2`, no `release-blocker`.
- Bug that breaks a critical flow (sign-in, payment, generation, account deletion) → `release-blocker` + `P0`.
- Bug that's high priority to fix but not actively breaking production → `P0` or `P1`, no `release-blocker`.

Examples (note the platform tag(s) on every client-facing ticket):
- "Account deletion silently fails on iOS" → `bug`, `ios`, `auth`, `release-blocker`, `P0`
- "IAP receipts not validating on iOS 18.2" → `bug`, `ios`, `payment`, `release-blocker`, `P0`
- "Replicate poll path can 429" → `bug`, `ai`, `backend`, `P2` (server-only — no platform label; self-heals next poll, not release-blocking)
- "Add light/dark mode toggle everywhere" → `feature`, `ios`, `android`, `web`, `P2` (cross-platform — all three)
- "Add aspect-ratio picker to the prompt bar" → `feature`, `ios`, `android`, `web`, `P2` (a prompt-bar control that ships on every client)
- "Refactor credit-grant service" → `chore`, `backend` (server-only — no platform label)
- "Android video saves to the photo library instead of videos on API 26–28" → `bug`, `android`, `P2`
- "Server telemetry tags Android errors as iOS" → `bug`, `android`, `backend`, `P2` (server change, but it's about the Android client → tag `android`)
- "Live Activities silently failing for 3% of users" → `bug`, `ios`, `push-notification`, `P1` (iOS-only feature, small blast radius, doesn't block release)

```bash
# Build the label flags from the axes that apply. Skip flags for axes you didn't pick.
# Type is required; everything else is conditional.
gh issue create \
  --repo <your-org>/<your-repo> \
  --title "<concise title>" \
  --body "<body from step 2>" \
  --label "<type>" \
  [--label "<surface-1>"] [--label "<surface-2>"] \
  [--label "<priority>"] \
  [--label "release-blocker"]
```

(The bracketed `[--label …]` flags are illustrative. In a real `gh` invocation, just omit the flag entirely if that axis doesn't apply — `gh` doesn't accept literal brackets.)

If you genuinely need a label that doesn't exist:
```bash
gh label create <name> --repo <your-org>/<your-repo> --color <hex> --description "<short>"
```
Don't invent ad-hoc labels — extend this skill's tables first if a new category is recurring.

### 4. Add to the your GitHub project board (Backlog)

The board is `your project board` (`<your-project-name>` for your GitHub user/org). If your repo name and project board name differ, set them in the bash commands below.

**Cached IDs for this project (as of 2026-05-05):**
```
PROJECT_NUMBER:  6
PROJECT_ID:      PVT_kwHOADTL5c4BVFsO
STATUS_FIELD_ID: PVTSSF_lAHOADTL5c4BVFsOzhQj14I
Status options:
  Backlog     -> f75ad846
  Ready       -> 61e4505c
  In progress -> 47fc9ee4
  In review   -> df73e18b
  Done        -> 98236657
```

If any of these stop working (project rename, field reshuffle), re-resolve:
```bash
gh project list --owner aryaxt --format json \
  | python3 -c "import sys,json; [print(p['number'],p['title'],p['id']) for p in json.load(sys.stdin)['projects']]"

gh project field-list 6 --owner aryaxt --format json \
  | python3 -c "import sys,json; d=json.load(sys.stdin); \
    [print(f['id'], f['name']) or [print(' ',o['name'],'->',o['id']) for o in f.get('options',[])] for f in d['fields']]"
```

**Add and move to Backlog:**
```bash
ITEM_ID=$(gh project item-add 6 --owner aryaxt --url <issue-url> --format json | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

gh project item-edit \
  --id "$ITEM_ID" \
  --project-id PVT_kwHOADTL5c4BVFsO \
  --field-id PVTSSF_lAHOADTL5c4BVFsOzhQj14I \
  --single-select-option-id f75ad846
```

### 5. Report to user

Print the issue URL, the labels applied, and a one-line summary. Call out severity explicitly if `release-blocker` was applied.

## Quality bar

A good issue means Claude can pick it up via `/work-on-issue` **without asking a single clarifying question**. If the implementation path is ambiguous, resolve it in Implementation Notes — don't leave it open.

## When to extend this skill

If you find yourself reaching for a label that doesn't fit any table above more than once, that's a signal to add it to the relevant axis (and create the GitHub label) rather than skipping it. Edit this file when:
- A new platform ships (the three clients — `ios`, `android`, `web` — are live; add the next one here if a new client appears)
- A new recurring Area emerges (e.g. `analytics`, `onboarding`)
- Project IDs change (project rename, field reshuffle, repo migration)
- The severity rubric needs sharpening based on actual release-blocker usage
