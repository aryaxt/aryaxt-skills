---
name: qa
description: Investigate a change or a bug report, drive the real app to see it (iOS via Appium, Android via adb + uiautomator, web via the browser, API via direct calls), screenshot every step along the way, then produce a beautiful report (HTML + a Markdown mirror for the PR + a self-contained PDF) — the path taken, every screen, plus class/DB diagrams when the code warrants — and open the PDF in Preview. In bug mode it also reproduces, root-causes, fixes, re-verifies (before/after), and hands the fix to /doit to ship. Use when the user types /qa, says "verify this works", "show me how it looks", "test the X flow", "qa this branch", "I found a bug …", "investigate why X is broken", or any variant of "make sure the UI actually works / prove this works".
---

# /qa — investigate, drive the app, and produce a visual walkthrough report

`/qa` does not write or run test code. It **understands the change, navigates the real app the way a user would, photographs every step, and writes up what it saw** as a comprehensive HTML report you can read top to bottom and actually understand how the feature behaves. It runs in two modes:

- **Verify mode** (default) — given the current branch's changes (or a named feature), figure out the user path to the affected UI, drive the app, screenshot each step, and report. This is what `/doit` calls before merge.
- **Bug mode** — given a bug description, investigate the code, reproduce the broken state on a device (with screenshots), find the root cause, implement the fix, re-drive to capture before/after, write the report, then **call `/doit`** to open the PR + review + merge. Report a bug, get a shipped fix with visual proof.

It auto-derives the navigation path from the code. There are **no hand-authored smoke-test steps** to maintain anymore (the old `## Visual smoke test` sections are optional hints, not a requirement).

---

## Step 1 — parse intent and pick the mode

```
ARG="$*"
```

- **Empty** → **verify mode** on the current branch diff (`git diff origin/main..HEAD`).
- **Reads like a malfunction** ("crashes when…", "X button does nothing", "wrong price shows", "it's not saving") → **bug mode**, `ARG` is the bug report.
- **Names a feature / screen / path** ("the upload menu", "create-model flow", "/admin") → **verify mode** targeting that.

When it's genuinely ambiguous whether the user is reporting a bug or asking to verify a feature, ask **one** short question. Otherwise proceed — don't interrogate.

State the chosen mode and target back in one line before doing anything: *"Verify mode — walking the upload-menu flow on iOS."* / *"Bug mode — investigating 'credits not deducted after edit'."*

## Step 2 — scope the surface(s)

A change can touch any combination of **iOS** (`ios/`), **Android** (`android/`), **web** (`src/app`, `src/components`), **admin** (`src/app/admin`), and **API/server** (`src/app/api`, `src/lib`). Determine which surface(s) the work actually touches:

- **Verify mode** → classify the diff (`git diff origin/main..HEAD --name-only`). Mirror `/doit` Step 5.5's per-surface regexes — only drive a surface the diff actually changed.
- **Bug mode** → from the bug description + a code investigation, decide where the bug lives and which surface reproduces it. A server bug may be reproducible by driving the client OR by hitting the endpoint directly — pick whichever shows the failure most clearly.

If multiple surfaces are affected, do each in its own report section. Don't let "tested on iOS" stand in for "tested on web."

**Coverage is mandatory, not best-effort — driving only iOS when the change also touches web/Android is a defective run.** This app is web + iOS + Android and most user-facing changes land on all three (or a shared server change fans out to all three per Step 3 #4). So:

1. **Write the surface list down first.** Before touching any device, state explicitly which surfaces are in scope and why, e.g. *"Surfaces in scope: iOS, Android, Web (shared scene-confirm sheet lives on all three)."* This list is a contract — the report must cover every surface on it.
2. **Drive every surface on the list.** iOS via Appium, Android via adb+uiautomator, web via the browser — each gets its own screenshots and its own report section. Being mid-iOS is not an excuse to skip Android/web.
3. **Never silently drop a surface.** If a surface is genuinely in scope but you cannot drive it (emulator won't boot, dev server down, blocked capability), you do **not** just omit it — you keep it in the report with an explicit **"Not covered — <reason>"** note so the gap is visible. A missing surface with no explanation is a bug in the run.
4. A surface is **out of scope only if the diff + impact analysis show it genuinely isn't affected** (e.g. an iOS-only Live Activity change never reaches web/Android). Say so explicitly rather than leaving it ambiguous.

## Step 3 — analyze the code and derive the path (the part that replaces authored steps)

Read the changed/relevant files and build a mental model of the flow **before touching a device**:

1. **Entry point → affected screen.** Trace how a user reaches the changed UI from app launch: which tab, which button opens which sheet, what state is required (logged in? has a model? has credits?). Write this out as a concrete numbered navigation plan — this is the script you'll execute on the device.
2. **What to assert.** For each step, decide what the screenshot should show to prove it works (a specific title, a new button, the sheet height, a badge count, an error card).
3. **Pre-conditions.** If the flow needs seeded state (a trained model, credits, a published post), note how to get there (an existing golden account, a debug menu action, a Firestore seed). Prefer reusing existing app state over fabricating it.
4. **Impact analysis — what *else* does this change touch?** Don't only test the screen that changed; test everything the change can affect. From the code, trace outward:
   - **Find the dependents.** For each changed type/function/route/field, grep for its call sites and importers (`grep -rn "<symbol>"` across `ios/`, `android/`, `src/`). A shared service, a model field, a util, an API route, or a changed server contract can ripple into screens far from the diff.
   - **Shared/server changes fan out to every client.** A change to an API route, response shape, Firestore field, or a shared `src/lib` module affects **iOS, Android, and web** at once — each consuming client is now in scope, even if only the server file changed.
   - **List the affected flows** and fold them into the navigation plan from #1: drive and screenshot **each** affected flow, not just the headline one. If a change touches credits, also verify a flow that spends credits elsewhere; if it touches the model list, verify every screen that reads it. Call out explicitly in the report which flows you exercised *because they were downstream of the change*.
   - If the blast radius is large, prioritize the highest-risk dependents and **state in the report which affected flows you did and did not cover**, with why.
5. **Decide which diagrams to include** (authored in Step 6, rendered in the report):
   - **Class / interaction diagram — REQUIRED whenever the change touches backend/server code non-trivially** (`src/app/api`, `src/lib`, services, providers, a changed server contract — i.e. more than one collaborating type, a new service/route, or a contract change; a one-line tweak to an existing handler doesn't qualify), and recommended whenever any surface's changed code is non-trivial (several collaborating types, a new service, a provider/adapter, a state machine). Author **one diagram per affected surface** — iOS, Android, web, backend — using the real types in that surface's code, not a generic sketch. A Mermaid `classDiagram` for structure, `sequenceDiagram` for a cross-layer call flow (e.g. client → API route → service → provider). When a flow crosses platforms (client → shared backend), a sequence diagram that spans them is ideal. Don't pad: only include a surface's diagram if that surface's code actually changed or is materially involved.
   - **Database / schema diagram** — when the feature **adds or changes persisted data** (a new Firestore collection, new fields, new indexes, a Storage path). A Mermaid `erDiagram` of the collections + key fields + relationships, plus a note on the security-rules surface.
   - Skip diagrams only for small/obvious changes with no backend involvement — otherwise they earn their place.

This step is where `/qa` earns its keep: it figures the path out itself, so you never have to write steps in a doc.

## Step 4 — set up the driver for each surface

Pick the right driver per platform. **Take a screenshot after every navigation action and every opened sheet** — those screenshots are the report.

### iOS → Appium (XCUITest)

1. Build + launch via the **`simulator` skill** (Skill tool, don't re-implement its bash) so the app is installed and current.
2. `select_device` → `prepare_ios_simulator` → `appium_session_management` (action=create). Capabilities come from `.claude/appium/capabilities.json` (attaches to the installed `com.shivaapps.photoai`, `noReset: true`).
3. Drive with `appium_get_page_source` (find real accessibility-ids / labels — **prefer stable locators over xpath**) → `appium_find_element` → `appium_gesture` (tap/scroll) / `appium_set_value` (type). Use `action=scroll_to_element` when a target is off-screen.
4. `appium_screenshot` returns base64 PNG — decode and save each into the report's `assets/` dir with a zero-padded ordinal + slug (`01-dashboard.png`, `02-upload-sheet.png`).
5. Tear the session down when done. **Leave the simulator running** — the user may be mid-test.

### Android → adb + uiautomator (no Appium)

Drive the emulator/device directly over `adb` (same approach as the `hinge-wingman` skill — lighter than standing up an Appium server):

- Launch / foreground: `adb shell monkey -p com.shivaapps.photoai -c android.intent.category.LAUNCHER 1`
- Inspect the view tree (real bounds + ids/text for locating, not pixel-guessing):
  `adb exec-out uiautomator dump /dev/tty` → parse the XML for the target node's `bounds`
- Tap / type / key: `adb shell input tap <x> <y>` · `adb shell input text "…"` · `adb shell input keyevent <KEY>`
- Screenshot each step: `adb exec-out screencap -p > assets/NN-slug.png`

Build + install first via `/simulator android` (or `/emulator`) so the build is current.

### Web / admin → the browser

Use the `preview_*` tools (or the `/chrome` skill) to boot the dev server and drive the affected flow. Screenshot each step with `preview_screenshot`. Check `preview_console_logs` / `preview_network` for errors and fold any into the report. (Admin lives at `/admin`.)

### API-only change → trigger it directly

When the change is server-only with no rendered surface (or you want to prove the endpoint independently):

- **Prefer driving the real client UI that calls the endpoint** when one exists — it proves the end-to-end behavior, and you capture both the screens and the network call (`preview_network` on web, the request/response on mobile).
- Otherwise **hit the endpoint directly** (curl / fetch) with a valid auth token, and capture the full **request and response** (method, path, headers sans secrets, body, status, response JSON) for the report. If the route needs App Check / admin, note how you satisfied it.

## Step 5 (bug mode only) — reproduce, root-cause, fix, re-verify

1. **Reproduce.** Drive the app to the failing state and screenshot it. If you can't reproduce, say so clearly and stop — don't fix a phantom.
2. **Root-cause.** From the code, identify *why* it breaks (not just where). Write a crisp root-cause statement for the report.
3. **Fix.** Implement the minimal correct fix. Follow the repo's conventions and the backward-compat gate (live production — no breaking server-contract / schema changes; if the only fix is breaking, STOP and surface it per AGENTS.md).
4. **Re-verify.** Re-drive the same path and capture the **after** screenshots. The report shows before (broken) vs after (fixed) side by side.

## Step 6 — build the HTML report

Write a **self-contained, beautiful** `report.html` into a gitignored per-run dir, with screenshots referenced from a sibling `assets/`. Alongside it, emit a **`report.md`** (the same walkthrough as Markdown) so `/doit` can post the report inline on the PR, and — because the HTML embeds only local `assets/` paths — a **`report.pdf`** (screenshots baked in) that opens in Preview and can be attached to a PR as a self-contained file:

```
.qa-reports/<YYYYMMDD-HHMMSS>-<slug>/
  report.html
  report.md          # Markdown mirror — /doit posts this as a PR comment (images uploaded so they render inline)
  report.pdf         # self-contained (screenshots embedded) — opens in Preview, attachable to a PR
  assets/01-….png  02-….png  …
```

Ensure `.qa-reports/` is gitignored (append it to the repo's `.gitignore` if missing — reports are local artifacts, never committed).

**`report.md` — the PR-facing mirror.** Same content as the HTML (header, summary, the numbered path-taken timeline with each screenshot inline via `![caption](assets/NN-slug.png)`, before/after, affected functionality, diagrams as fenced ```` ```mermaid ```` blocks — GitHub renders these natively — API calls, root cause + fix, verdict). For a multi-platform run, drop the segmented control and just use one `## iOS` / `## Android` / `## Web` / `## Backend` H2 section per platform. Keep the image paths **relative** (`assets/NN-slug.png`); `/doit` rewrites them to the uploaded URLs when it posts the comment. This file is what actually reaches the PR, so it must stand on its own as a readable document.

**`report.pdf` — render it from the finished HTML** (after Step 6.5's self-review, so the PDF reflects the clean report), via headless Chrome:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --print-to-pdf-no-header \
  --print-to-pdf="$(pwd)/.qa-reports/<dir>/report.pdf" \
  "file://$(pwd)/.qa-reports/<dir>/report.html"
```

If the report has a platform segmented control, only the default segment is visible in print — that's acceptable for the PDF (the `report.md` carries all platforms); or print with all panels forced visible via a print stylesheet (`@media print { [data-platform] { display:block !important } }`) so every platform lands in the PDF. Prefer the print-stylesheet approach so the PDF is complete.

The report must let the user *understand how it was tested and see how the UI looked*. Structure:

1. **Header** — feature/bug title, mode, surfaces, branch, date, one-line verdict (✅ verified / ✅ fixed / ❌ failed).
2. **Summary** — 2-4 sentences: what was changed/broken, what was tested, the outcome.
3. **The path taken** — a numbered timeline. **Each step = its screenshot inline + a caption** describing the action and what the screenshot proves. This is the heart of the report; make it readable as a story.
4. **Before / after** (bug mode) — the broken state next to the fixed state.
5. **Affected functionality** — the downstream flows from Step 3 #4 that you exercised because the change rippled into them, each with its screenshots and a note on *why* it was in scope. Make it clear these are impact-coverage, not the headline flow.
6. **Diagrams** (when Step 3 flagged them) — render Mermaid via CDN (`https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js`, `mermaid.initialize({startOnLoad:true, theme:'dark'})`). Author real `classDiagram` / `sequenceDiagram` / `erDiagram` source from the actual code, with a sentence explaining each. When the change touches backend, include the **per-surface class/interaction diagrams** (iOS, Android, web, backend) plus a cross-layer sequence diagram for the request flow.
7. **API calls** (when triggered) — request + response, pretty-printed, secrets redacted.
8. **Root cause + fix** (bug mode) — the root-cause statement and a short summary of the change (link the touched files).
9. **Verdict / notes** — what passed, anything not covered, follow-ups.

### Multi-platform reports — segment by platform

When the run covers **more than one platform** (e.g. a backend change verified on iOS + Android + web), put a **segmented control at the top of the report** with one segment per platform involved (iOS · Android · Web · Backend), and show only the selected platform's sections (path taken, screenshots, affected functionality, that surface's class diagram) at a time. Shared sections (header, summary, DB/schema diagram, cross-layer sequence diagram, verdict) stay outside the segments. Implement it as plain inline HTML/CSS/JS — labelled buttons that toggle `.active` on `<section data-platform="…">` panels; no framework, keep it in the single self-contained file. Default to the first segment selected. A single-platform run shows **no** segmented control — just the linear report.

**Styling:** dark, product-aligned (navy surface `#0B0B12`, raised `#15151F`, indigo accent `#6E66F0`, white headings, muted body). Generous radii, hairline borders, screenshots in rounded cards with a subtle border. It should look designed, not like a dump. Keep it one self-contained HTML file (inline CSS; Mermaid is the only CDN).

## Step 6.5 — self-review the report before showing it (REQUIRED — do not skip)

**You wrote the HTML; you have not yet seen it rendered.** Never hand the user a report you haven't looked at. Render it, inspect it like a designer, fix every defect, and only then proceed to Step 7. The user should never be the one to discover a broken report.

**Render it and look at it.** Open the file in a real browser engine and capture what it actually looks like — not what you intended:

```
# Full-page screenshot via headless Chrome (file:// loads local assets/ fine)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --hide-scrollbars --window-size=1400,2200 \
  --screenshot="/tmp/qa-report-check.png" \
  "file://$(pwd)/.qa-reports/<dir>/report.html"
```

Then **Read that screenshot** (the image, not the HTML source) and scan it as a human would. Re-shoot at a second width (e.g. `--window-size=900,2200`) to catch responsive breakage. If a region is taller than one viewport, capture it in sections or raise the height — make sure you've actually seen the whole document, top to bottom.

**The UI-bug checklist** — look for and fix each:
- **Broken/missing images** — a screenshot card showing a broken-image glyph or empty box means a wrong relative path (`assets/NN-slug.png`) or a file that never got saved. Verify every referenced asset exists on disk and resolves.
- **Overflow / clipping** — text or images spilling out of cards, horizontal scrollbars, captions cut off, screenshots squashed or stretched (wrong aspect ratio).
- **Contrast / readability** — body text that's too dark on the dark surface, low-contrast captions, an accent used where it disappears. Everything must be comfortably legible.
- **Layout** — misaligned cards, collapsed/zero-height containers, broken grid/flow, content colliding with the header, awkward giant gaps.
- **Mermaid** — diagrams must actually **render to SVG**, not show raw ```` ```mermaid ```` source or an error box. (Headless screenshot may race the CDN — if a diagram looks unrendered, also open it visibly and confirm before blaming the report.) Verify the diagram content matches the real code, not a placeholder.
- **Empty / placeholder content** — no `TODO`, `lorem`, `undefined`, `[object Object]`, or stub captions left in.
- **Platform segmented control** (multi-platform reports) — clicking each segment must actually swap to that platform's panel; exactly one panel visible at a time, the default segment shows on load, and no panel is orphaned/hidden-forever. Drive it (open visibly and click each segment, or read the toggle JS) and confirm every platform's content is reachable.
- **Surface-coverage completeness** — cross-check the rendered report against the in-scope surface list you wrote in Step 2. **Every in-scope surface must appear** with either real screenshots or an explicit "Not covered — <reason>" note. If the list said iOS + Android + Web but the report only has iOS, the run is incomplete: go back to Step 4, drive the missing surface(s), and only then re-render. Do not show the user a report that silently covers fewer platforms than the change touched.

**If the report contains any custom animation or CSS transition, review it frame by frame.** A still screenshot cannot prove an animation is correct. Open the report visibly and capture the motion across time, then inspect the frames:

```
open -a "Google Chrome" ".qa-reports/<dir>/report.html"
# capture ~4s of the animated region, then split into frames
# (use the computer-use screen-record tools, or a timed screenshot burst)
ffmpeg -i /tmp/qa-anim.mov -vf fps=12 /tmp/qa-frames/f-%03d.png
```

Read the frame sequence and confirm the animation **starts, runs, and ends cleanly** — no flash of unstyled/jumped first frame, no stutter or snap-back, no element stuck mid-transition, no infinite loop that should have settled, correct easing and final resting state. Fix the CSS/JS and re-capture until the motion is clean. (This applies to animation *inside the report HTML itself* — for animation in the app feature being QA'd, screenshots can't capture it; see "When NOT to use this skill.")

**This sub-step only runs if the report actually has custom animation/transitions** — most reports are static screenshots-in-cards and skip it entirely. If `ffmpeg` (or a screen-record tool) isn't available, fall back to a timed burst of screenshots; if you can't capture motion at all, say so in your summary rather than blocking the report.

**Re-render after every fix** and re-inspect — don't assume the edit worked. Only once the rendered report is clean on every point above do you move to Step 7.

## Step 7 — render the PDF and open it in Preview

Now that the HTML is clean (Step 6.5), render `report.pdf` from it (the `--print-to-pdf` command in Step 6) so the PDF reflects the reviewed report, then open **the PDF in Preview** — not the HTML in Chrome:

```
open -a Preview ".qa-reports/<dir>/report.pdf"
```

Preview renders PDF/images, not HTML — so the deliverable the user opens is the PDF. (The `report.html` remains on disk as the interactive version; the `report.md` is what `/doit` posts to the PR.) Tell the user the report dir and give a 2-3 line spoken summary of the verdict. The report is the deliverable — don't recreate it in chat.

## Step 8 (bug mode with a fix) — hand off to /doit

If you made a code change, **invoke `/doit`** (Skill tool) to ship it. `/doit` owns branch + PR + multi-agent review + merge — `/qa` does **not** open its own PR. Pass `/doit` the context and **the report dir path** so it can post `report.md` inline on the PR (and attach `report.pdf`) — `/doit`'s "QA report → PR" step owns the image upload + comment. On a clean branch, `/doit` will create the branch; otherwise it splits/commits as usual.

Verify mode never auto-ships — it only reports.

---

## When NOT to use this skill

- **Performance / animation feel** — screenshots can't capture jank or frame drops. Drive the sim and screen-record instead (see `/doit` Step 5.5's animation note).
- **Real-device-only capabilities** — push, biometrics, camera, ARKit. Use `/device`.
- **Pure refactors / type-only / comment changes** with no observable behavior — there's nothing to walk; unit tests are the verification.

## Notes

- **Not a replacement for unit tests.** `/qa` covers what tests can't reach (real rendering, sheets, navigation, system overlays) and produces human-readable evidence. Anything testable headlessly should still be a Vitest / Swift Test.
- **Locate elements by id/label/bounds from the live view tree, never hardcoded coordinates** — window position and density vary.
- **First iOS/Android build is 2-3 min** (shared build cache with `/simulator`); subsequent runs are fast.
- **Don't shut the simulator/emulator down** when finished — the user may keep testing.
- A feature doc's `## Visual smoke test` section, if present, is a useful **hint** for the path — read it, but you're not bound to it and you don't need one to run.
